/** Public configuration and typed failures for the combined session-query service. */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Default maximum `before`/`after` raw-event window. */
export const SESSION_QUERY_READ_WINDOW_MAX = 50

/** Default maximum number of concurrent persisted-log reads in one batch read. */
export const SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY = 4

/** Default maximum number of cold prepared-Session observations retained for reuse. */
export const SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE = 5

/** Default estimated heap retained by cached cold prepared-Session observations. */
export const SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_BYTES = 128 * 1024 * 1024

/** Default share of free V8 heap one cold open may estimate before it is refused. */
export const SESSION_QUERY_DEFAULT_COLD_OPEN_HEAP_SHARE = 0.5

/**
 * Default estimated heap bytes per stored artifact byte for a cold open.
 *
 * A restored Session keeps one event object per stored event, so its heap cost
 * exceeds the stored artifact. The default is a conservative multiple for the
 * JSONL backend; measure the backend in use and raise it when its artifacts
 * decompress or decode into more heap than this multiple prices.
 */
export const SESSION_QUERY_DEFAULT_COLD_OPEN_HEAP_MULTIPLIER = 8

/** Backend-independent configuration inherited by every session-query implementation. */
export interface Config {
  /** Maximum accepted raw read context on either side. Defaults to 50. */
  readWindowMax?: number
  /** Maximum concurrent persisted-log reads in one batch read. Defaults to 4. */
  persistedReadConcurrency?: number
  /**
   * Maximum cold prepared-Session observations retained for reuse, keyed by
   * durable revision. Entries pinned by active observation leases do not count
   * against this bound until released. Defaults to 5.
   */
  preparedSessionCacheSize?: number
  /**
   * Estimated heap bytes retained by cached cold observations; entries are
   * evicted least-recently-used until the retained estimate fits. A pinned
   * entry counts against the estimate but is never evicted. `0` disables the
   * byte bound. Defaults to 128 MiB.
   */
  preparedSessionCacheBytes?: number
  /**
   * Share of free V8 heap a single cold observation may estimate before the read
   * is refused with `SESSION_QUERY_SESSION_TOO_LARGE`. `0` disables the guard.
   * Defaults to 0.5.
   */
  coldOpenHeapShare?: number
  /**
   * Estimated heap bytes per stored artifact byte, applied only when the backend
   * reports `sizeBytes`; it also prices retained cache entries. Defaults to 8.
   */
  coldOpenHeapMultiplier?: number
}

/** Stable machine-routable failure taxonomy for session reads, traces, and search. */
export type SessionQueryErrorCode =
  | 'SESSION_QUERY_ABORTED'
  | 'SESSION_QUERY_CORRUPT_SESSION'
  | 'SESSION_QUERY_EVENT_NOT_FOUND'
  | 'SESSION_QUERY_INDEX_FAILED'
  | 'SESSION_QUERY_INVALID_CONFIG'
  | 'SESSION_QUERY_INVALID_CURSOR'
  | 'SESSION_QUERY_INVALID_FILTER'
  | 'SESSION_QUERY_INVALID_LIMIT'
  | 'SESSION_QUERY_INVALID_QUERY'
  | 'SESSION_QUERY_INVALID_LINEAGE'
  | 'SESSION_QUERY_INVALID_SURFACE'
  | 'SESSION_QUERY_INVALID_WINDOW'
  | 'SESSION_QUERY_PERSISTENCE_FAILED'
  | 'SESSION_QUERY_SEARCH_DISABLED'
  | 'SESSION_QUERY_SESSION_NOT_FOUND'
  | 'SESSION_QUERY_SESSION_TOO_LARGE'
  | 'SESSION_QUERY_STALE_CURSOR'
  | 'SESSION_QUERY_SOURCE_CONFLICT'

/** Typed session-query failure whose `code` is one closed taxonomy member. */
export class SessionQueryError extends HarnessError {
  declare readonly code: SessionQueryErrorCode

  // The base stores the value; this signature narrows its open string code.
  // oxlint-disable-next-line typescript/no-useless-constructor
  constructor(message: string, code: SessionQueryErrorCode, options?: ErrorOptions) {
    super(message, code, options)
  }
}
