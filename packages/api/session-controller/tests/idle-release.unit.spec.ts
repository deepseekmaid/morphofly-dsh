/** Branch-level unit coverage for the idle-release scheduler and its abort paths. */

import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IdleAgentRelease } from '../src/idle-release.ts'

/** Mutable stand-in state for one fake Agent. */
interface FakeState {
  status: 'idle' | 'running'
  nextTurn: unknown[]
  nextStep: unknown[]
  gate?: { readonly promise: Promise<void>; resolve(): void }
}

/** Deferred the fake Agent's `whenIdle` waits on. */
function deferred(): { promise: Promise<void>; resolve(): void } {
  const resolved = Promise.withResolvers<undefined>()
  return { promise: resolved.promise, resolve: () => { resolved.resolve(undefined) } }
}

/** Controllable world behind the production Context reads. */
interface World {
  ctx: Context
  readonly agents: Map<SessionId, Agent>
  readonly warnings: string[]
  readonly children: { header: { parentSession?: SessionId } }[]
  jobs: { list(caller: SessionId): { status: string }[] } | undefined
  terminals: { list(agent: Agent): unknown[] } | undefined
  failAgentLookup: boolean
  readonly states: Map<SessionId, FakeState>
  readonly disposed: SessionId[]
}

function world(): World {
  const agents = new Map<SessionId, Agent>()
  const warnings: string[] = []
  const children: { header: { parentSession?: SessionId } }[] = []
  const states = new Map<SessionId, FakeState>()
  const disposed: SessionId[] = []
  const ctx = {
    agents: {
      get: (id: SessionId) => {
        if (owner.failAgentLookup) throw new Error('registry unavailable')
        return agents.get(id)
      },
    },
    sessions: { list: () => children },
    get: (name: string) => (name === 'jobs' ? owner.jobs : name === 'terminals' ? owner.terminals : undefined),
    logger: { warn: (message: string) => { warnings.push(message) } },
  } as Context
  const owner: World = {
    ctx,
    agents,
    warnings,
    children,
    jobs: undefined,
    terminals: undefined,
    failAgentLookup: false,
    states,
    disposed,
  }
  return owner
}

/** Publish one fake Agent for `id` and return its handle and mutable state. */
function publish(owner: World, id: SessionId): { handle: AgentHandle; state: FakeState } {
  const state: FakeState = { status: 'idle', nextTurn: [], nextStep: [] }
  const agent = {
    id,
    get status() { return state.status },
    get inbox(): { readonly nextTurn: readonly unknown[]; readonly nextStep: readonly unknown[] } {
      return { nextTurn: state.nextTurn, nextStep: state.nextStep }
    },
    whenIdle: () => state.gate?.promise ?? Promise.resolve(),
  } as Agent
  owner.states.set(id, state)
  owner.agents.set(id, agent)
  const handle: AgentHandle = {
    agent,
    dispose: async () => { owner.disposed.push(id) },
  }
  return { handle, state }
}

const ids = {
  a: SessionId('idle-unit-a'),
  b: SessionId('idle-unit-b'),
}

afterEach(() => {
  vi.useRealTimers()
})

describe('IdleAgentRelease scheduler', () => {
  it('is inert while release is disabled', async () => {
    const owner = world()
    const release = new IdleAgentRelease(owner.ctx, { graceMs: 0 })
    const { handle } = publish(owner, ids.a)
    release.track(handle)
    const stop = release.start()
    stop()
    await release.releaseIdle()
    expect(owner.disposed).toEqual([])
    expect(release.enabled).toBe(false)
  })

  it('runs the configured scan and contains a failing scan', async () => {
    vi.useFakeTimers()
    const owner = world()
    const release = new IdleAgentRelease(owner.ctx, { graceMs: 10, sweepMs: 1_000, now: () => Date.now() })
    const { handle } = publish(owner, ids.a)
    release.track(handle)
    const stop = release.start()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(owner.disposed).toEqual([ids.a])

    owner.failAgentLookup = true
    const { handle: failing } = publish(owner, ids.b)
    release.track(failing)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(owner.warnings.some(message => message.includes('idle release scan failed'))).toBe(true)
    stop()
  })

  it('skips a Session whose release is already in flight', async () => {
    const owner = world()
    let now = 0
    const release = new IdleAgentRelease(owner.ctx, { graceMs: 1, now: () => now })
    const { handle, state } = publish(owner, ids.a)
    state.gate = deferred()
    release.track(handle)
    now = 10
    const first = release.releaseIdle()
    await Promise.resolve()
    expect(release.isReleasing(ids.a)).toBe(true)
    const second = release.releaseIdle()
    state.gate.resolve()
    delete state.gate
    await Promise.all([first, second])
    expect(release.isReleasing(ids.a)).toBe(false)
    expect(owner.disposed).toEqual([ids.a])
  })

  it('forgets a tracked lifecycle whose Agent left the registry', async () => {
    const owner = world()
    let now = 0
    const release = new IdleAgentRelease(owner.ctx, { graceMs: 1, now: () => now })
    const { handle } = publish(owner, ids.a)
    release.track(handle)
    now = 10
    owner.agents.delete(ids.a)
    await release.releaseIdle()
    expect(owner.disposed).toEqual([])
    owner.agents.set(ids.a, handle.agent)
    await release.releaseIdle()
    expect(owner.disposed).toEqual([])
  })

  it('aborts after quiescence when the Session was activated again', async () => {
    const owner = world()
    let now = 0
    const release = new IdleAgentRelease(owner.ctx, { graceMs: 5, now: () => now })
    const { handle, state } = publish(owner, ids.a)
    state.gate = deferred()
    release.track(handle)
    now = 10
    const pending = release.releaseIdle()
    await Promise.resolve()
    now = 20
    release.touch(ids.a)
    state.gate.resolve()
    await pending
    expect(owner.disposed).toEqual([])
  })

  it('aborts after quiescence when the Agent was replaced', async () => {
    const owner = world()
    let now = 0
    const release = new IdleAgentRelease(owner.ctx, { graceMs: 1, now: () => now })
    const { handle, state } = publish(owner, ids.a)
    state.gate = deferred()
    release.track(handle)
    now = 10
    const pending = release.releaseIdle()
    await Promise.resolve()
    const replacement = publish(owner, ids.a).handle.agent
    owner.agents.set(ids.a, replacement)
    state.gate.resolve()
    await pending
    expect(owner.disposed).toEqual([])
    owner.agents.delete(ids.a)
    await release.releaseIdle()
    expect(owner.disposed).toEqual([])
  })

  it('aborts after quiescence when the tracked lifecycle was replaced', async () => {
    const owner = world()
    let now = 0
    const release = new IdleAgentRelease(owner.ctx, { graceMs: 1, now: () => now })
    const { handle, state } = publish(owner, ids.a)
    state.gate = deferred()
    release.track(handle)
    now = 10
    const pending = release.releaseIdle()
    await Promise.resolve()
    const replacement = publish(owner, ids.a)
    release.track(replacement.handle)
    state.gate.resolve()
    await pending
    expect(owner.disposed).toEqual([])
    now = 20
    await release.releaseIdle()
    expect(owner.disposed).toEqual([ids.a])
  })

  it('aborts after quiescence when an owner appeared meanwhile', async () => {
    const owner = world()
    let now = 0
    const release = new IdleAgentRelease(owner.ctx, { graceMs: 1, now: () => now })
    const { handle, state } = publish(owner, ids.a)
    state.gate = deferred()
    release.track(handle)
    now = 10
    const pending = release.releaseIdle()
    await Promise.resolve()
    state.status = 'running'
    state.gate.resolve()
    await pending
    expect(owner.disposed).toEqual([])
  })

  it('contains a failing disposal and keeps scanning', async () => {
    const owner = world()
    let now = 0
    const release = new IdleAgentRelease(owner.ctx, { graceMs: 1, now: () => now })
    const { handle } = publish(owner, ids.a)
    Object.defineProperty(handle, 'dispose', {
      value: () => Promise.reject(new Error('dispose exploded')),
    })
    release.track(handle)
    now = 10
    await release.releaseIdle()
    await Promise.resolve()
    expect(owner.warnings.some(message => message.includes('releasing idle Agent'))).toBe(true)
  })
})

describe('IdleAgentRelease blockers', () => {
  it.each([
    ['a running turn', (owner: World) => { (owner.states.get(ids.a) as FakeState).status = 'running' }],
    ['pending inbox input', (owner: World) => { (owner.states.get(ids.a) as FakeState).nextTurn.push({}) }],
    ['a running background job', (owner: World) => { owner.jobs = { list: () => [{ status: 'running' }] } }],
    ['a live terminal', (owner: World) => { owner.terminals = { list: () => [{ id: 'pty-1' }] } }],
    ['a live subagent Session', (owner: World) => { owner.children.push({ header: { parentSession: ids.a } }) }],
  ])('keeps an Agent with %s', async (_name, arrange) => {
    const owner = world()
    let now = 0
    const release = new IdleAgentRelease(owner.ctx, { graceMs: 1, now: () => now })
    const { handle } = publish(owner, ids.a)
    release.track(handle)
    now = 10
    arrange(owner)
    await release.releaseIdle()
    expect(owner.disposed).toEqual([])

    // Clearing the owner lets the next scan release the same Agent.
    const state = owner.states.get(ids.a) as FakeState
    state.status = 'idle'
    state.nextTurn.length = 0
    owner.jobs = undefined
    owner.terminals = undefined
    owner.children.length = 0
    await release.releaseIdle()
    expect(owner.disposed).toEqual([ids.a])
  })

  it('settles immediately without an in-flight release and ignores touch for unknown Sessions', async () => {
    const owner = world()
    const release = new IdleAgentRelease(owner.ctx, { graceMs: 1, now: () => 10 })
    await release.settled(ids.b)
    release.touch(ids.b)
    expect(release.isReleasing(ids.b)).toBe(false)
  })
})
