import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { AssistantStreamRecord } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'

const stream: readonly AssistantStreamRecord[] = [
  { type: 'chunk', time: 10, chunk: { type: 'text-delta', index: 0, text: 'hi' } },
  { type: 'chunk', time: 20, chunk: { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } } },
]
const attempt = { turn: 1, step: 1 }

describe('Session append carrier', () => {
  let ctx: Context

  beforeEach(async () => {
    ctx = new Context()
    await ctx.plugin(SessionStore)
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
  })

  function live(): Session {
    const session = Session.create(SessionId('carrier'))
    ctx.effect(() => ctx.sessions.enter(session))
    ctx.sessions.announce(session)
    return session
  }

  it('lets a synchronous session/event writer claim the payload exactly once', () => {
    const claims: (readonly AssistantStreamRecord[] | undefined)[] = []
    ctx.on('session/event', (session, event) => { claims.push(session.takeAssistantStream(event.seq)) })
    const session = live()
    const event = session.appendWithCarry('assistant/attempt', attempt, { assistantStream: stream })
    expect(claims).toEqual([stream])
    expect(session.takeAssistantStream(event.seq)).toBeUndefined()
  })

  it('serves the first listener only', () => {
    const first: (readonly AssistantStreamRecord[] | undefined)[] = []
    const second: (readonly AssistantStreamRecord[] | undefined)[] = []
    ctx.on('session/event', (session, event) => { first.push(session.takeAssistantStream(event.seq)) })
    ctx.on('session/event', (session, event) => { second.push(session.takeAssistantStream(event.seq)) })
    live().appendWithCarry('assistant/attempt', attempt, { assistantStream: stream })
    expect(first).toEqual([stream])
    expect(second).toEqual([undefined])
  })

  it('drops an unclaimed payload when the append returns', () => {
    const session = live()
    const event = session.appendWithCarry('assistant/attempt', attempt, { assistantStream: stream })
    expect(session.takeAssistantStream(event.seq)).toBeUndefined()
  })

  it('leaves nothing to claim for an append without a payload', () => {
    const session = live()
    const event = session.append('assistant/attempt', attempt)
    expect(session.takeAssistantStream(event.seq)).toBeUndefined()
  })

  it('never copies the payload into the event or the log', () => {
    const session = live()
    const event = session.appendWithCarry('assistant/attempt', attempt, { assistantStream: stream })
    expect(Object.keys(event.data)).toEqual(['turn', 'step'])
    expect(event.data).toEqual(attempt)
    expect(session.snapshotEvents()).toEqual([event])
  })

  it('carries a payload alongside a surface append', () => {
    const claims: (readonly AssistantStreamRecord[] | undefined)[] = []
    ctx.on('session/event', (session, event) => { claims.push(session.takeAssistantStream(event.seq)) })
    const session = live()
    const message = createAssistantMessage({ content: [], source: { provider: 'test', model: 'test' } })
    const event = session.appendWithCarry(
      'assistant/message',
      { turn: 1, step: 1, message },
      { assistantStream: stream },
      { surfaceOp: 'append' },
    )
    expect(event.surfaceOp).toBe('append')
    expect(claims).toEqual([stream])
  })

  it('drops the payload when the append itself is rejected', () => {
    const session = live()
    expect(() => session.appendWithCarry(
      'assistant/attempt',
      { turn: 1, step: 1, usage: { inputTokens: Number.NaN, outputTokens: 1 } },
      { assistantStream: stream },
    )).toThrow('non-JSON-serializable')
    expect(session.seq).toBe(0)
    expect(session.snapshotEvents()).toEqual([])
  })

  it('keeps a detached Session free of carried state after append', () => {
    const session = Session.create(SessionId('detached'))
    const event = session.appendWithCarry('assistant/attempt', attempt, { assistantStream: stream })
    expect(session.takeAssistantStream(event.seq)).toBeUndefined()
  })
})
