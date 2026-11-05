/**
 * Idle release for Web-resumed Agents.
 *
 * Every Agent this package resumes or creates on a browser's behalf stays in
 * the process registries until someone disposes it. Without release, opening a
 * Session makes its complete event log resident for the life of the process —
 * the dominant memory cost of a long-lived Web host.
 *
 * @module @deepseek-ai/dsh-api-session-controller/idle-release
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-jobs'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-terminal'

/** Deployment policy for releasing idle Web Agents. */
export interface IdleReleasePolicy {
  /**
   * Milliseconds an Agent may stay idle after its last activation before it is
   * released; `0` disables idle release.
   */
  readonly graceMs: number
  /** Milliseconds between idle scans; ignored while release is disabled. */
  readonly sweepMs: number
}

/** Construction options: the policy plus an optional test clock. */
export interface IdleReleaseOptions extends Partial<IdleReleasePolicy> {
  /** Clock used for activity stamps; defaults to `Date.now`. */
  readonly now?: () => number
}

/** One tracked Agent lifecycle and its last observed activation. */
interface TrackedAgent {
  readonly handle: AgentHandle
  lastActive: number
}

/**
 * Tracks the Agents this package published on a browser's behalf and releases
 * them once they are idle past the grace period.
 *
 * A release is due only while the Agent is idle, holds no pending inbox input,
 * and owns no work whose owner would outlive it: a running background job, a
 * live terminal, or a live subagent Session. The scan revalidates all of that
 * after the Agent quiesces, because activity may arrive while the release
 * waits.
 */
export class IdleAgentRelease {
  private readonly tracked = new Map<SessionId, TrackedAgent>()
  /** In-flight releases, awaited by callers that must not observe the disposing Agent. */
  private readonly releasing = new Map<SessionId, Promise<void>>()
  private readonly graceMs: number
  private readonly sweepMs: number
  private readonly now: () => number

  /**
   * @param ctx - Host context carrying the Agent registry and the optional
   *   owners whose work keeps an Agent busy (jobs, terminals).
   * @param options - grace period, scan interval, and test clock.
   */
  constructor(private readonly ctx: Context, options: IdleReleaseOptions = {}) {
    this.graceMs = options.graceMs ?? 0
    this.sweepMs = options.sweepMs ?? 30_000
    this.now = options.now ?? Date.now
  }

  /**
   * Whether one Session's Agent is being released right now.
   * @param sessionId - Session identity to test.
   * @returns true between beginning a release and its settlement.
   */
  isReleasing(sessionId: SessionId): boolean {
    return this.releasing.has(sessionId)
  }

  /** Whether the configured policy enables idle release at all. */
  get enabled(): boolean {
    return this.graceMs > 0
  }

  /**
   * Start the periodic scan.
   * @returns the disposer that stops the scan and clears its timer.
   */
  start(): () => void {
    if (!this.enabled) return () => {}
    const timer = setInterval(() => {
      void this.releaseIdle().catch((error: unknown) => {
        this.ctx.logger.warn(`session-controller: idle release scan failed: ${errorChain(error)}`)
      })
    }, this.sweepMs)
    // Idle cleanup is not work the process owes anyone: it must not hold a host open.
    timer.unref()
    return () => { clearInterval(timer) }
  }

  /**
   * Record one published Agent lifecycle and stamp its activation.
   * @param handle - the published Agent lifecycle to track.
   */
  track(handle: AgentHandle): void {
    if (!this.enabled) return
    this.tracked.set(handle.agent.id, { handle, lastActive: this.now() })
  }

  /**
   * Stamp an activation that arrives while a release may be in flight.
   * @param sessionId - the Session whose activation to stamp.
   */
  touch(sessionId: SessionId): void {
    const tracked = this.tracked.get(sessionId)
    if (tracked !== undefined) tracked.lastActive = this.now()
  }

  /**
   * Await any in-flight release of one Session so a caller never receives the
   * Agent that is being disposed.
   * @param sessionId - Session identity whose Agent may be being released.
   */
  async settled(sessionId: SessionId): Promise<void> {
    await this.releasing.get(sessionId)
  }

  /** Release every tracked Agent idle past the grace period. */
  async releaseIdle(): Promise<void> {
    if (!this.enabled) return
    const now = this.now()
    const releases: Promise<void>[] = []
    for (const [sessionId, tracked] of this.tracked) {
      if (this.releasing.has(sessionId)) continue
      if (now - tracked.lastActive < this.graceMs) continue
      const release = this.beginRelease(sessionId, tracked)
      if (release !== undefined) releases.push(release)
    }
    await Promise.allSettled(releases)
  }

  /**
   * Mark one Session as releasing and dispose its Agent after revalidation.
   * @param sessionId - due Session identity.
   * @param tracked - the tracked lifecycle observed by the scan.
   * @returns the release settlement, or undefined when the Agent is not ours or is busy.
   */
  private beginRelease(sessionId: SessionId, tracked: TrackedAgent): Promise<void> | undefined {
    const agent = this.ctx.agents.get(sessionId)
    if (agent !== tracked.handle.agent) {
      // Disposed or replaced by another owner since this lifecycle was tracked.
      this.tracked.delete(sessionId)
      return undefined
    }
    if (this.blocker(agent) !== undefined) return undefined
    const gate = Promise.withResolvers<void>()
    this.releasing.set(sessionId, gate.promise)
    const release = (async () => {
      try {
        await agent.whenIdle()
        // Activity or owners may have arrived while the Agent quiesced.
        const latest = this.tracked.get(sessionId)
        if (latest !== tracked) return
        if (this.now() - latest.lastActive < this.graceMs) return
        const current = this.ctx.agents.get(sessionId)
        if (current !== tracked.handle.agent) {
          this.tracked.delete(sessionId)
          return
        }
        if (this.blocker(current) !== undefined) return
        this.tracked.delete(sessionId)
        await tracked.handle.dispose()
      } finally {
        // The scan never starts a second release for a Session still in `releasing`.
        this.releasing.delete(sessionId)
        gate.resolve()
      }
    })()
    release.catch((error: unknown) => {
      this.ctx.logger.warn(`session-controller: releasing idle Agent "${sessionId}" failed: ${errorChain(error)}`)
    })
    return release
  }

  /**
   * Name the owner that keeps one Agent live, if any.
   * @param agent - live Agent considered for release.
   * @returns the blocking reason, or undefined when the Agent may be released.
   */
  private blocker(agent: Agent): string | undefined {
    if (agent.status === 'running') return 'running'
    const inbox = agent.inbox
    if (inbox.nextTurn.length > 0 || inbox.nextStep.length > 0) return 'pending-inbox'
    const jobs = this.ctx.get('jobs')
    if (jobs !== undefined && jobs.list(agent.id).some(job => job.status === 'running')) return 'background-job'
    const terminals = this.ctx.get('terminals')
    if (terminals !== undefined && terminals.list(agent).length > 0) return 'terminal'
    // A live subagent Session roots its parent's Agent: releasing the parent
    // would strand the child's delivery and tree ownership.
    if (this.ctx.sessions.list().some(session => session.header.parentSession === agent.id)) return 'subagent'
    return undefined
  }
}
