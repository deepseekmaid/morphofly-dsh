/** Shared live/prepared observations for Session page and lifecycle consumers. */

import { getHeapStatistics } from 'node:v8'
import type { Context } from '@deepseek-ai/cordis'
import { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader, SessionId , SessionLogOffset as SessionLogOffsetType , SessionSeqCursor } from '@deepseek-ai/dsh-session'
import type SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import type {
  SessionPersistenceRevision,
  SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import {
  SESSION_QUERY_DEFAULT_COLD_OPEN_HEAP_MULTIPLIER,
  SESSION_QUERY_DEFAULT_COLD_OPEN_HEAP_SHARE,
  SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_BYTES,
  SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE,
  SessionQueryError,
} from './config.ts'
import { readColdSessionLog, type ColdSessionLog } from './cold-read.ts'

/** One exact immutable Session cut retained for the caller's read lifetime. */
export interface SessionObservation extends Disposable {
  /** Whether the cut came from an attached Session or a retained preparation. */
  readonly source: 'live' | 'prepared'
  /** Immutable Session identity metadata. */
  readonly header: SessionHeader
  /** Exact fork-inherited event count paired with {@link header}. */
  readonly inheritedEventCount: SessionLogOffsetType
  /**
   * Immutable contiguous events at {@link cursor}. A live observation
   * materializes this array on first read, so a consumer that reads only the
   * header, cursor, or projections never copies the log.
   */
  readonly events: readonly SessionEvent[]
  /** Last observed event seq, or -1 for an empty log. */
  readonly cursor: SessionSeqCursor
  /** Durable source revision for a cold prepared observation. */
  readonly revision?: SessionPersistenceRevision
  /** Exact projection baseline at {@link cursor}, when the registry is mounted. */
  readonly projections?: ProjectionSnapshot
  /**
   * Retain the same immutable cut for another Host owner.
   * @returns an independently disposable lease over this observation.
   */
  retain(): SessionObservation
}

/** Bounds this reader applies to cold prepared observations. */
export interface SessionObservationLimits {
  /** Estimated heap bytes retained by unpinned entries; `0` disables the byte bound. */
  readonly cacheBytes?: number
  /** Share of free V8 heap one cold open may estimate; `0` disables the guard. */
  readonly coldOpenHeapShare?: number
  /** Estimated heap bytes per stored artifact byte. */
  readonly coldOpenHeapMultiplier?: number
}

/** Projection work and cancellation requested for one exact observation. */
export interface SessionObservationOptions {
  /** Optional cancellation while resolving a cold source. */
  readonly signal?: AbortSignal
  /** Whether to compute every projection or leave projection state untouched. */
  readonly projectionMode?: 'all' | 'none'
}

/**
 * One reusable cold observation: an unpublished restored Session plus the
 * exact balanced log it represents, valid while the producing persistence
 * instance still reports the same revision.
 */
interface PreparedEntry {
  /** Stable service identity whose `stat` produced this revision; proxy references are not instance identities. */
  readonly persistenceIdentity: symbol
  /** Durable revision observed by `stat` immediately before the log read. */
  readonly revision: SessionPersistenceRevision
  /** Unpublished Session restored from the balanced log; never entered into the store. */
  readonly session: Session
  /** Immutable balanced log (stored events plus in-memory interrupted-turn closers). */
  readonly events: readonly SessionEvent[]
  /** Estimated heap bytes this entry retains, from the stored artifact size. */
  readonly bytes: number
  /** Active observation leases; a pinned entry (`refs > 0`) is never evicted. */
  refs: number
}

/**
 * Builds point observations without a corpus listing preflight.
 *
 * Cold reads are cached per session id, keyed by the persistence instance and
 * the `stat` revision observed before the log read: an unchanged revision
 * reuses the restored Session without re-reading the log. The cache is bounded
 * by `cacheCapacity` entries and by `cacheBytes` of estimated heap
 * (least-recently-used unpinned entries are evicted past either bound), and
 * entries pinned by active leases survive eviction and replacement — a lease's
 * cut stays valid for the lease lifetime even after a newer revision lands.
 * A cache miss prices the stored artifact through `coldOpenHeapShare` of the
 * free V8 heap before reading it, and refuses an oversized open.
 */
export class SessionObservationReader {
  private readonly cache = new Map<SessionId, PreparedEntry>()
  private readonly cacheBytes: number
  private readonly coldOpenHeapShare: number
  private readonly coldOpenHeapMultiplier: number
  /** Running estimate of the heap bytes the cache retains. */
  private retainedBytes = 0

  /**
   * @param ctx - context carrying Session and optional persistence/projection services.
   * @param cacheCapacity - maximum unpinned cold observations retained for reuse.
   * @param limits - byte budget and cold-open guard policy; defaults come from `config.ts`.
   */
  constructor(
    private readonly ctx: Context,
    private readonly cacheCapacity: number = SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE,
    limits: SessionObservationLimits = {},
  ) {
    this.cacheBytes = limits.cacheBytes ?? SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_BYTES
    this.coldOpenHeapShare = limits.coldOpenHeapShare ?? SESSION_QUERY_DEFAULT_COLD_OPEN_HEAP_SHARE
    this.coldOpenHeapMultiplier = limits.coldOpenHeapMultiplier ?? SESSION_QUERY_DEFAULT_COLD_OPEN_HEAP_MULTIPLIER
  }

  /**
   * Observe one live-preferred Session and retain a cold preparation until disposal.
   * @param sessionId - logical Session identity.
   * @param options - cancellation and all-or-none projection computation for this read.
   * @returns one exact immutable observation.
   * @throws {@link SessionQueryError} `SESSION_QUERY_SESSION_TOO_LARGE` when a cold open exceeds its heap share.
   * @throws {@link SessionQueryError} with code `SESSION_QUERY_CORRUPT_SESSION` when live or prepared projection computation fails.
   */
  async read(
    sessionId: SessionId,
    options: SessionObservationOptions = {},
  ): Promise<SessionObservation> {
    const { signal, projectionMode = 'all' } = options
    for (;;) {
      throwIfObservationAborted(signal)
      const live = this.ctx.sessions.get(sessionId)
      if (live !== undefined) return this.live(live, projectionMode)
      const persistence = this.ctx.get('sessionPersistence')
      if (persistence === undefined) throw notFound(sessionId)

      const snapshot = await this.statSource(persistence, sessionId, signal)
      const attachedDuringStat = this.ctx.sessions.get(sessionId)
      if (attachedDuringStat !== undefined) return this.live(attachedDuringStat, projectionMode)
      let entry = this.cachedEntry(persistence.identity, sessionId, snapshot.revision)
      if (entry === undefined) {
        this.assertColdOpenAffordable(sessionId, snapshot)
        const loaded = await this.loadSource(persistence, sessionId, signal)
        throwIfObservationAborted(signal)
        const attached = this.ctx.sessions.get(sessionId)
        if (attached !== undefined) return this.live(attached, projectionMode)
        // The handle marks persisted events as adoptable; synthetic closers
        // are owned by this read, so the combined seed needs no copy.
        const seed = loaded.events
        let session: Session
        try {
          session = this.ctx.sessions.prepare(sessionId, {
            seed,
            meta: structuredClone(loaded.header),
            inheritedEventCount: loaded.inheritedEventCount,
            eventState: loaded.eventState,
          })
        } catch (error: unknown) {
          // The store rejects an id with a live owner: that owner is the
          // fresher source, so retry the live path. Any other rejection means
          // the stored log failed restore validation.
          if (this.ctx.sessions.get(sessionId) !== undefined) continue
          throw new SessionQueryError(
            `stored session "${sessionId}" is corrupt: ${errorMessage(error)}`,
            'SESSION_QUERY_CORRUPT_SESSION',
            { cause: error },
          )
        }
        entry = {
          persistenceIdentity: persistence.identity,
          revision: snapshot.revision,
          session,
          events: Object.freeze(seed),
          bytes: this.estimateBytes(snapshot),
          refs: 0,
        }
        this.store(sessionId, entry)
      }

      let projections: ProjectionSnapshot | undefined
      try {
        projections = projectionMode === 'none' ? undefined : this.preparedProjections(entry)
      } catch (error: unknown) {
        throw new SessionQueryError(
          `failed to project session "${sessionId}": ${errorMessage(error)}`,
          'SESSION_QUERY_CORRUPT_SESSION',
          { cause: error },
        )
      }
      return this.preparedLease(sessionId, entry, projections)
    }
  }

  /** Observe the stored snapshot, mapping absence and backend failures to the query taxonomy. */
  private async statSource(
    persistence: SessionPersistence,
    sessionId: SessionId,
    signal: AbortSignal | undefined,
  ): Promise<SessionPersistenceSnapshot> {
    let snapshot: SessionPersistenceSnapshot | undefined
    try {
      snapshot = await persistence.stat(sessionId, signal === undefined ? undefined : { signal })
    } catch (error: unknown) {
      throwIfObservationAborted(signal)
      throw mapPersistenceFailure(sessionId, error)
    }
    throwIfObservationAborted(signal)
    if (snapshot === undefined) throw notFound(sessionId)
    if (snapshot.header.id !== sessionId) {
      throw new SessionQueryError(
        `session persistence returned "${snapshot.header.id}" for "${sessionId}"`,
        'SESSION_QUERY_SOURCE_CONFLICT',
      )
    }
    return snapshot
  }

  /** Read the complete balanced cold log, mapping backend failures to the query taxonomy. */
  private async loadSource(
    persistence: SessionPersistence,
    sessionId: SessionId,
    signal: AbortSignal | undefined,
  ): Promise<ColdSessionLog> {
    try {
      return await readColdSessionLog(persistence, sessionId, signal)
    } catch (error: unknown) {
      throwIfObservationAborted(signal)
      throw mapPersistenceFailure(sessionId, error)
    }
  }

  /** Return a still-valid cached entry and mark it most recently used. */
  private cachedEntry(
    persistenceIdentity: symbol,
    sessionId: SessionId,
    revision: SessionPersistenceRevision,
  ): PreparedEntry | undefined {
    const cached = this.cache.get(sessionId)
    if (cached === undefined || cached.persistenceIdentity !== persistenceIdentity || cached.revision !== revision) {
      return undefined
    }
    this.cache.delete(sessionId)
    this.cache.set(sessionId, cached)
    return cached
  }

  /** Insert or replace the entry for one id, then evict past the entry and byte bounds. */
  private store(sessionId: SessionId, entry: PreparedEntry): void {
    // Replacing a stale revision only drops the map's reference; live leases
    // keep the old entry alive through their own references.
    const replaced = this.cache.get(sessionId)
    if (replaced !== undefined) this.retainedBytes -= replaced.bytes
    this.cache.delete(sessionId)
    this.cache.set(sessionId, entry)
    this.retainedBytes += entry.bytes
    this.evictPastCapacity(entry)
  }

  /**
   * Evict oldest unpinned entries until the cache fits its entry and byte
   * bounds again. Runs on store and whenever a lease release unpins an entry,
   * so leases that pinned every candidate cannot leave the cache over budget
   * for good.
   * @param keep - the entry being stored, about to be leased; never evicted.
   */
  private evictPastCapacity(keep?: PreparedEntry): void {
    for (const [id, candidate] of this.cache) {
      if (this.withinBounds()) return
      if (candidate === keep || candidate.refs > 0) continue
      this.cache.delete(id)
      this.retainedBytes -= candidate.bytes
    }
  }

  /** Whether the retained cache fits both the entry count and the byte budget. */
  private withinBounds(): boolean {
    return this.cache.size <= this.cacheCapacity
      && (this.cacheBytes === 0 || this.retainedBytes <= this.cacheBytes)
  }

  /**
   * Refuse a cold open whose estimated heap cost exceeds its share of free V8
   * heap. The estimate prices the stored artifact at the configured multiple; a
   * backend that reports no `sizeBytes` cannot be priced and passes.
   * @param sessionId - the stored session about to be loaded.
   * @param snapshot - the stat result that priced it.
   * @throws {SessionQueryError} `SESSION_QUERY_SESSION_TOO_LARGE` when the estimate does not fit.
   */
  private assertColdOpenAffordable(sessionId: SessionId, snapshot: SessionPersistenceSnapshot): void {
    if (this.coldOpenHeapShare === 0 || snapshot.sizeBytes === undefined) return
    const estimated = this.estimateBytes(snapshot)
    const free = freeHeapBytes()
    const budget = Math.floor(free * this.coldOpenHeapShare)
    if (estimated <= budget) return
    throw new SessionQueryError(
      `session "${sessionId}" is too large to open: about ${formatBytes(estimated)} of heap for ${formatBytes(snapshot.sizeBytes)} stored, but only ${formatBytes(free)} of heap is free; close other Sessions or restart the host with a larger heap`,
      'SESSION_QUERY_SESSION_TOO_LARGE',
    )
  }

  /** Estimate the heap one cold observation of a stored artifact retains. */
  private estimateBytes(snapshot: SessionPersistenceSnapshot): number {
    return snapshot.sizeBytes === undefined
      ? 0
      : Math.ceil(snapshot.sizeBytes * this.coldOpenHeapMultiplier)
  }

  /** Build one disposable lease over a cached entry, pinning it until every lease releases. */
  private preparedLease(
    sessionId: SessionId,
    entry: PreparedEntry,
    projections: ProjectionSnapshot | undefined,
  ): SessionObservation {
    entry.refs += 1
    const lease = (): SessionObservation => {
      let disposed = false
      return {
        source: 'prepared',
        header: entry.session.header,
        inheritedEventCount: entry.session.inheritedEventCount,
        events: entry.events,
        cursor: entry.events.at(-1)?.seq ?? -1,
        revision: entry.revision,
        ...projections === undefined ? {} : { projections },
        retain: () => {
          if (disposed) throw new Error(`session observation "${sessionId}" is disposed`)
          entry.refs += 1
          return lease()
        },
        [Symbol.dispose]: () => {
          if (disposed) return
          disposed = true
          entry.refs -= 1
          if (entry.refs === 0) this.evictPastCapacity()
        },
      }
    }
    return lease()
  }

  private live(
    session: Session,
    projectionMode: NonNullable<SessionObservationOptions['projectionMode']>,
  ): SessionObservation {
    // The cut is the log length now. The log only appends, so the prefix
    // below `seq` is the same array whenever a consumer first reads `events`.
    const seq = session.seq
    let materialized: readonly SessionEvent[] | undefined
    let projections: ProjectionSnapshot | undefined
    try {
      projections = projectionMode === 'none'
        ? undefined
        : this.ctx.get('sessionProjections')?.snapshot(session)
    } catch (error: unknown) {
      throw new SessionQueryError(
        `failed to project session "${session.id}": ${errorMessage(error)}`,
        'SESSION_QUERY_CORRUPT_SESSION',
        { cause: error },
      )
    }
    const lease = (): SessionObservation => {
      let disposed = false
      return {
        source: 'live',
        header: session.header,
        inheritedEventCount: session.inheritedEventCount,
        get events() {
          // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
          materialized ??= session.snapshotEvents(SessionLogOffset(0), seq)
          return materialized
        },
        cursor: seq === 0 ? -1 : SessionSeq(seq - 1),
        ...projections === undefined ? {} : { projections },
        retain: () => {
          if (disposed) throw new Error(`session observation "${session.id}" is disposed`)
          return lease()
        },
        [Symbol.dispose]: () => { disposed = true },
      }
    }
    return lease()
  }

  private preparedProjections(entry: PreparedEntry): ProjectionSnapshot | undefined {
    const registry = this.ctx.get('sessionProjections')
    if (registry === undefined) return undefined
    const cache = this.ctx.get('sessionProjectionCache')
    return cache === undefined
      ? registry.hydrate(entry.session, {}, entry.events, SessionLogOffset(0))
      : cache.hydratePrepared(entry.session, entry.events)
  }
}

/** Free V8 heap one cold open may estimate against, in bytes. */
function freeHeapBytes(): number {
  return Math.max(0, getHeapStatistics().heap_size_limit - process.memoryUsage().heapUsed)
}

/** Render a byte count for an operator-facing refusal message. */
function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB'] as const
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit] as string}`
}

function throwIfObservationAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return
  throw new SessionQueryError(
    'session observation was aborted',
    'SESSION_QUERY_ABORTED',
    { cause: signal.reason },
  )
}

function mapPersistenceFailure(sessionId: SessionId, error: unknown): SessionQueryError {
  if (hasErrorName(error, 'SessionPersistenceNotFoundError')) return notFound(sessionId, error)
  if (hasErrorName(error, 'SessionPersistenceCorruptionError')) {
    return new SessionQueryError(
      `stored session "${sessionId}" is corrupt: ${error.message}`,
      'SESSION_QUERY_CORRUPT_SESSION',
      { cause: error },
    )
  }
  return new SessionQueryError(
    `failed to observe session "${sessionId}": ${errorMessage(error)}`,
    'SESSION_QUERY_PERSISTENCE_FAILED',
    { cause: error },
  )
}

function notFound(sessionId: SessionId, cause?: unknown): SessionQueryError {
  return new SessionQueryError(
    `session "${sessionId}" not found`,
    'SESSION_QUERY_SESSION_NOT_FOUND',
    cause === undefined ? undefined : { cause },
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}

function hasErrorName(error: unknown, name: string): error is Error {
  return error instanceof Error && error.name === name
}
