/**
 * Idle release against the real Agent loop and JSONL persistence: a released
 * Session must stay durable and listed, its row must not be reported as
 * removed, and the next operation must resume it.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionSummary } from '../src/types.ts'
import { createSessionTestRemote, type TestSessionRemote } from './test-remote.ts'

const ownedContexts = new Set<Context>()
const ownedRoots = new Set<string>()

afterEach(async () => {
  await Promise.all([...ownedContexts].map(ctx => ctx.fiber.dispose()))
  ownedContexts.clear()
  await Promise.all([...ownedRoots].map(root => rm(root, { recursive: true, force: true })))
  ownedRoots.clear()
})

/** Session events a Session records at creation, before any prompt. */
const configurationEvents = [
  { type: 'permission/preset', seq: SessionSeq(0), time: 1, data: { preset: 'danger-full-access' } },
  { type: 'sandbox/mode', seq: SessionSeq(1), time: 2, data: { mode: 'danger-full-access' } },
  { type: 'approval/policy', seq: SessionSeq(2), time: 3, data: { policy: 'never' } },
] as SessionEvent[]

/** One conversation turn, so the Session is not blank in list reads. */
const conversationEvents = [
  { type: 'turn/start', seq: SessionSeq(3), time: 4, data: { turn: 1 } },
  {
    type: 'user/message', seq: SessionSeq(4), time: 4,
    data: createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }),
    surfaceOp: 'append',
  },
  { type: 'turn/end', seq: SessionSeq(5), time: 5, data: { turn: 1, reason: { kind: 'completed' } } },
] as SessionEvent[]

interface Harness {
  readonly ctx: Context
  readonly remote: TestSessionRemote
  readonly cwd: string
}

/** Compose the real Agent loop, JSONL persistence, and Session Controller. */
async function harness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-idle-release-integration-'))
  ownedRoots.add(root)
  const ctx = new Context()
  ownedContexts.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root })
  const remote = await createSessionTestRemote(ctx, {
    defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
    cwd: root,
    idleReleaseGraceMs: 25,
    idleReleaseSweepMs: 5,
  })
  await mountAgentLoopTestHarness(ctx)
  return { ctx, remote, cwd: root }
}

/** Store one Session through persistence so a later resume seeds it from disk. */
async function storeSession(ctx: Context, id: SessionId, cwd: string, events: readonly SessionEvent[]): Promise<void> {
  const prepared = ctx.sessions.prepare(id, { meta: { cwd } })
  const handle = await ctx.sessionPersistence.create(prepared.header)
  await handle.append(events)
  await handle.close()
}

/** Poll until the predicate holds, so real-timer release scans stay deterministic. */
async function until(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not reached before timeout')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Activate one stored Session through the Web controller's resume path. */
async function activate(remote: TestSessionRemote, id: SessionId): Promise<void> {
  await remote.selectModel({ sessionId: id, provider: 'p', model: 'm' })
}

describe('idle release against the real Agent loop', () => {
  it('keeps a released Session durable and listed instead of removing its row', async () => {
    const { ctx, remote, cwd } = await harness()
    const id = SessionId('session-idle-released')
    await storeSession(ctx, id, cwd, [...configurationEvents, ...conversationEvents])
    const removed: SessionId[] = []
    const added: SessionSummary[] = []
    ctx.on('api-session/removed', sessionId => removed.push(sessionId))
    ctx.on('api-session/added', (summary) => {
      if (summary.sessionId === id) added.push(summary)
    })

    await activate(remote, id)
    expect(ctx.agents.get(id)).toBeDefined()

    await until(() => ctx.agents.get(id) === undefined)
    expect(ctx.sessions.get(id)).toBeUndefined()
    expect(removed).not.toContain(id)
    // The paired agent disposal republishes the row as cold and visible.
    expect(added.length).toBeGreaterThan(0)
    expect(added.at(-1)).toMatchObject({ sessionId: id, running: false, agentAvailable: false })

    const listed = await remote.list({})
    if (!listed.ok) throw new Error('list failed')
    const row: SessionSummary | undefined = listed.value.items.find(item => item.sessionId === id)
    expect(row).toBeDefined()
    expect(row?.running).toBe(false)
    expect(row?.agentAvailable).toBe(false)

    await activate(remote, id)
    expect(ctx.agents.get(id)).toBeDefined()
    expect(removed).not.toContain(id)
  })

  it('still reports a removal for a lifecycle disposed outside idle release', async () => {
    const { ctx, cwd } = await harness()
    const id = SessionId('session-other-disposal')
    await storeSession(ctx, id, cwd, [...configurationEvents, ...conversationEvents])
    const removed: SessionId[] = []
    ctx.on('api-session/removed', sessionId => removed.push(sessionId))
    const handle = await ctx.agents.resume({ resumeSessionId: id })
    const agent: Agent = handle.agent
    expect(ctx.agents.get(id)).toBe(agent)

    await handle.dispose()
    expect(removed).toContain(id)
  })
})
