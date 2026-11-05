/** Idle release of Web-published Agents: grace, activity, busy owners, and re-resume. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader, UserMessage } from '@deepseek-ai/dsh-session'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiSessionAgentController } from '../src/agent.ts'
import { installSessionReadTestServices, testSessionPersistence } from './test-remote.ts'

const roots: Context[] = []
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function header(id: string, cwd = '/workspace'): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 1, isSeeded: false, cwd }
}

/** Deferred the fake Agent's `whenIdle` waits on while a release is in flight. */
interface IdleGate {
  readonly promise: Promise<void>
  resolve(): void
}

/** Mutable per-Session lifecycle the fake factory republishes and tests drive. */
interface FakeLifecycle {
  status: 'idle' | 'running'
  readonly nextTurn: UserMessage[]
  readonly nextStep: UserMessage[]
  /** When set, `whenIdle` waits for this gate before releasing. */
  idleGate?: IdleGate
}

/** Publishes real store entries around controllable Agent stand-ins. */
class FakeLifecycles {
  readonly lifecycles = new Map<SessionId, FakeLifecycle>()
  readonly agents = new Map<SessionId, Agent>()
  readonly disposals: SessionId[] = []
  readonly resumes: SessionId[] = []

  constructor(private readonly ctx: Context) {}

  lifecycle(id: SessionId): FakeLifecycle {
    const existing = this.lifecycles.get(id)
    if (existing !== undefined) return existing
    const created: FakeLifecycle = { status: 'idle', nextTurn: [], nextStep: [] }
    this.lifecycles.set(id, created)
    return created
  }

  publish(id: SessionId): AgentHandle {
    const state = this.lifecycle(id)
    const session = this.ctx.sessions.prepare(id, { meta: header(id) })
    const detachSession = this.ctx.sessions.enter(session)
    this.ctx.sessions.announce(session)
    const agent = {
      id,
      session,
      ctx: this.ctx,
      get status() { return state.status },
      inbox: {
        get nextTurn(): readonly UserMessage[] { return state.nextTurn },
        get nextStep(): readonly UserMessage[] { return state.nextStep },
      },
      whenIdle: () => state.idleGate?.promise ?? Promise.resolve(),
      cancel: () => {},
    } as Agent
    const detachAgent = this.ctx.agents.enter(agent)
    this.agents.set(id, agent)
    let disposed = false
    return {
      agent,
      dispose: async () => {
        if (disposed) return
        disposed = true
        this.disposals.push(id)
        detachAgent()
        detachSession()
      },
    }
  }

  resume = async (id: SessionId): Promise<AgentHandle> => {
    this.resumes.push(id)
    return this.publish(id)
  }

  create = async (options: { sessionId: SessionId }): Promise<AgentHandle> => {
    this.resumes.push(options.sessionId)
    return this.publish(options.sessionId)
  }
}

interface Fixture {
  readonly ctx: Context
  readonly controller: ApiSessionAgentController
  readonly fake: FakeLifecycles
  readonly clock: { now: number }
  readonly cwd: string
  /** Headers the fake persistence reports for `observeSession`. */
  readonly headers: Map<SessionId, SessionHeader>
}

async function fixture(options: { graceMs?: number; seed?: (ctx: Context) => void } = {}): Promise<Fixture> {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  installSessionReadTestServices(ctx)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
    saveSelection: () => Promise.resolve(),
  } as never)
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-idle-release-'))
  tempDirs.push(cwd)
  const headers = new Map<SessionId, SessionHeader>()
  const seeded = header('idle-release-seed', cwd)
  headers.set(seeded.id, seeded)
  ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
    list: () => Promise.resolve([...headers.values()]),
    inspect: (sessionId: SessionId) => {
      const meta = headers.get(sessionId)
      return Promise.resolve(meta === undefined ? undefined : { meta, events: [] })
    },
  }) as never)
  options.seed?.(ctx)
  const fake = new FakeLifecycles(ctx)
  vi.spyOn(ctx.agents, 'resume').mockImplementation(async options => fake.resume(options.resumeSessionId))
  vi.spyOn(ctx.agents, 'create').mockImplementation(async options => fake.create(options))
  const clock = { now: 0 }
  const controller = new ApiSessionAgentController(ctx, {
    graceMs: options.graceMs ?? 100,
    sweepMs: 60_000,
    now: () => clock.now,
  })
  controller.initialize()
  return { ctx, controller, fake, clock, cwd, headers }
}

async function activate(fixture: Fixture, id: SessionId): Promise<Agent> {
  fixture.headers.set(id, header(id, fixture.cwd))
  const result = await fixture.controller.resolveAgent(id)
  if ('error' in result) throw result.error
  return result.agent
}

describe('ApiSession idle release', () => {
  it('releases an idle Agent after the grace period and resumes it on the next request', async () => {
    const f = await fixture()
    const id = SessionId('idle-ready')
    const first = await activate(f, id)
    expect(f.fake.resumes).toEqual([id])

    f.clock.now = 99
    await f.controller.releaseIdle()
    expect(f.fake.disposals).toEqual([])
    expect(f.ctx.agents.get(id)).toBe(first)

    f.clock.now = 100
    await f.controller.releaseIdle()
    expect(f.fake.disposals).toEqual([id])
    expect(f.ctx.agents.get(id)).toBeUndefined()
    expect(f.ctx.sessions.get(id)).toBeUndefined()

    const second = await activate(f, id)
    expect(second).not.toBe(first)
    expect(f.fake.resumes).toEqual([id, id])
  })

  it('keeps an Agent that is running a turn', async () => {
    const f = await fixture()
    const id = SessionId('running')
    await activate(f, id)
    f.fake.lifecycle(id).status = 'running'
    f.clock.now = 1_000
    await f.controller.releaseIdle()
    expect(f.fake.disposals).toEqual([])

    f.fake.lifecycle(id).status = 'idle'
    await f.controller.releaseIdle()
    expect(f.fake.disposals).toEqual([id])
  })

  it('keeps an Agent whose inbox still holds pending input', async () => {
    const f = await fixture()
    const id = SessionId('pending-input')
    await activate(f, id)
    f.fake.lifecycle(id).nextTurn.push({} as UserMessage)
    f.clock.now = 1_000
    await f.controller.releaseIdle()
    expect(f.fake.disposals).toEqual([])

    f.fake.lifecycle(id).nextTurn.length = 0
    await f.controller.releaseIdle()
    expect(f.fake.disposals).toEqual([id])
  })

  it('keeps an Agent that owns a running background job', async () => {
    const jobs = { running: true }
    const f = await fixture({ seed: (ctx) => {
      ctx.provide('jobs', {
        list: (owner: SessionId) => owner === SessionId('with-job') && jobs.running ? [{ status: 'running' }] : [],
      } as never)
    } })
    const id = SessionId('with-job')
    await activate(f, id)
    f.clock.now = 1_000
    await f.controller.releaseIdle()
    expect(f.fake.disposals).toEqual([])

    jobs.running = false
    await f.controller.releaseIdle()
    expect(f.fake.disposals).toEqual([id])
  })

  it('keeps an Agent that owns a live terminal', async () => {
    const terminals = { open: true }
    const f = await fixture({ seed: (ctx) => {
      ctx.provide('terminals', {
        list: (owner: Agent) => owner.id === SessionId('with-terminal') && terminals.open ? [{ id: 'pty-1' }] : [],
      } as never)
    } })
    const id = SessionId('with-terminal')
    await activate(f, id)
    f.clock.now = 1_000
    await f.controller.releaseIdle()
    expect(f.fake.disposals).toEqual([])

    terminals.open = false
    await f.controller.releaseIdle()
    expect(f.fake.disposals).toEqual([id])
  })

  it('keeps an Agent that still roots a live subagent session', async () => {
    const f = await fixture()
    const id = SessionId('with-child')
    await activate(f, id)
    const child = SessionId('subagent-child')
    const childSession = f.ctx.sessions.prepare(child, {
      meta: { ...header(child), parentSession: id, origin: 'subagent' },
    })
    const detachChild = f.ctx.sessions.enter(childSession)
    f.ctx.sessions.announce(childSession)
    f.clock.now = 1_000
    await f.controller.releaseIdle()
    expect(f.fake.disposals).toEqual([])

    detachChild()
    await f.controller.releaseIdle()
    expect(f.fake.disposals).toEqual([id])
  })

  it('restarts the grace period on every activation', async () => {
    const f = await fixture()
    const id = SessionId('touched')
    await activate(f, id)
    f.clock.now = 80
    await activate(f, id)
    f.clock.now = 160
    await f.controller.releaseIdle()
    expect(f.fake.disposals).toEqual([])

    f.clock.now = 180
    await f.controller.releaseIdle()
    expect(f.fake.disposals).toEqual([id])
  })

  it('waits for an in-flight release before resuming instead of returning the disposing Agent', async () => {
    const f = await fixture()
    const id = SessionId('releasing')
    const first = await activate(f, id)
    const gate = Promise.withResolvers<undefined>()
    f.fake.lifecycle(id).idleGate = { promise: gate.promise, resolve: () => { gate.resolve(undefined) } }
    f.clock.now = 1_000
    const releasing = f.controller.releaseIdle()
    // Give the release scan a chance to mark the Session as releasing.
    await Promise.resolve()
    const waiting = f.controller.resolveAgent(id)
    f.fake.lifecycle(id).idleGate?.resolve()
    delete f.fake.lifecycle(id).idleGate
    await releasing
    const resumed = await waiting
    // A plain identity comparison: the resumed Agent must be a different lifecycle.
    if ('agent' in resumed && resumed.agent === first) throw new Error('resolved the disposing Agent')
    if ('error' in resumed) throw new Error(`resume failed: ${resumed.error.message}`)
    expect(f.fake.disposals).toEqual([id])
    expect(f.fake.resumes).toEqual([id, id])
  })

  it('does not release while disabled', async () => {
    const f = await fixture({ graceMs: 0 })
    const id = SessionId('disabled')
    await activate(f, id)
    f.clock.now = 1_000_000
    await f.controller.releaseIdle()
    expect(f.fake.disposals).toEqual([])
  })

  it('releases from the periodic scan once the release timer is started', async () => {
    const f = await fixture()
    const id = SessionId('swept')
    await activate(f, id)
    vi.useFakeTimers()
    try {
      const stop = f.controller.startIdleRelease()
      f.clock.now = 1_000
      await vi.advanceTimersByTimeAsync(60_000)
      expect(f.fake.disposals).toEqual([id])
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('tracks Agents created through the tracked-creation path (fork)', async () => {
    const f = await fixture()
    const id = SessionId('forked')
    f.headers.set(id, header(id, f.cwd))
    await f.controller.createTrackedAgent({ sessionId: id })
    expect(f.ctx.agents.get(id)).toBeDefined()
    f.clock.now = 1_000
    await f.controller.releaseIdle()
    expect(f.fake.disposals).toEqual([id])
  })

  it('tracks Sessions created through createSession, not only resumed ones', async () => {
    const f = await fixture()
    const created = await f.controller.createSession({ cwd: f.cwd, reusable: () => true })
    const id = created.agent.id
    expect(f.ctx.agents.get(id)).toBe(created.agent)
    f.clock.now = 1_000
    await f.controller.releaseIdle()
    expect(f.fake.disposals).toEqual([id])
  })
})
