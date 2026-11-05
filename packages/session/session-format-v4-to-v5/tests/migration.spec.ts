import { describe, expect, it } from 'vitest'
import { SessionFormatEventCollector } from '@deepseek-ai/dsh-session-format'
import type {
  SessionFormatEvent,
  SessionFormatHeader,
  SessionFormatJsonObject,
  SessionFormatJsonValue,
} from '@deepseek-ai/dsh-session-format'
import { assistantStreamFirstTokenTime } from '@deepseek-ai/dsh-llm'
import type { AssistantStreamRecord } from '@deepseek-ai/dsh-llm'
import { sessionFormatV4ToV5 } from '../src/index.ts'

const header: SessionFormatHeader = { version: 4, id: 'identity', createdAt: 1, isSeeded: false, delegationDepth: 0 }
const usage = { inputTokens: 3, outputTokens: 5 }
const message = { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] }
const stream: readonly AssistantStreamRecord[] = [
  { type: 'chunk', time: 100, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
  { type: 'chunk', time: 120, chunk: { type: 'text-delta', index: 0, text: 'Hello' } },
  { type: 'chunk', time: 140, chunk: { type: 'usage', usage } },
  { type: 'chunk', time: 150, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } } },
]

function stage(sourceHeader = header, sourceInheritedEventCount?: number) {
  return sessionFormatV4ToV5.createStage({
    sourceHeader,
    targetHeader: sessionFormatV4ToV5.migrateHeader(sourceHeader),
    sourceInheritedEventCount,
    sourceKind: 'decoded',
  })
}

function migrate(events: readonly SessionFormatEvent[], sourceHeader = header, cut?: number) {
  const current = stage(sourceHeader, cut)
  const output = new SessionFormatEventCollector()
  for (const event of events) current.transformEvent(event, output)
  return { events: output.values, cut: current.finish(output) }
}

function settlement(seq: number, data: Record<string, unknown> = {}): SessionFormatEvent {
  return { type: 'assistant/message', seq, time: 200, data: { turn: 1, step: 1, message, stream: jsonStream(stream), usage, ...data } }
}

function jsonStream(stream: readonly AssistantStreamRecord[]): readonly SessionFormatJsonValue[] {
  return JSON.parse(JSON.stringify(stream)) as readonly SessionFormatJsonValue[]
}

function payload(event: SessionFormatEvent): SessionFormatJsonObject {
  return event.data as SessionFormatJsonObject
}

describe('V4 to V5 header migration', () => {
  it('stamps the target writer version without changing other metadata', () => {
    expect(sessionFormatV4ToV5.migrateHeader(header)).toEqual({ ...header, version: 5 })
    expect(() => sessionFormatV4ToV5.migrateHeader({ ...header, version: 3 })).toThrow()
  })
})

describe('V4 to V5 settlement transformation', () => {
  it('removes the embedded stream while keeping the message, usage, and interruption marker', () => {
    const { events } = migrate([settlement(0, { interrupted: true })])
    expect(events).toHaveLength(1)
    const data = payload(events[0]!)
    expect(Object.hasOwn(data, 'stream')).toBe(false)
    expect(data['message']).toEqual(message)
    expect(data['usage']).toEqual(usage)
    expect(data['interrupted']).toBe(true)
  })

  it('derives first-token latency from the removed stream', () => {
    expect(assistantStreamFirstTokenTime(stream)).toBe(120)
    const data = payload(migrate([settlement(0)]).events[0]!)
    expect(data['firstTokenTime']).toBe(120)
  })

  it('omits first-token latency when the stream carries no token', () => {
    const tokenless: readonly AssistantStreamRecord[] = [
      { type: 'chunk', time: 100, chunk: { type: 'usage', usage } },
    ]
    const data = payload(migrate([settlement(0, { stream: tokenless })]).events[0]!)
    expect(Object.hasOwn(data, 'firstTokenTime')).toBe(false)
    expect(Object.hasOwn(data, 'stream')).toBe(false)
  })

  it('carries attempt usage and first-token latency out of the removed stream', () => {
    const attempt: SessionFormatEvent = { type: 'assistant/attempt', seq: 0, time: 300, data: { turn: 1, step: 1, stream: jsonStream(stream) } }
    expect(migrate([attempt]).events[0]!.data).toEqual({ turn: 1, step: 1, usage, firstTokenTime: 120 })
  })

  it('omits attempt usage when the stream has no usage chunk', () => {
    const bare: readonly AssistantStreamRecord[] = [
      { type: 'chunk', time: 120, chunk: { type: 'text-delta', index: 0, text: 'Hello' } },
    ]
    const attempt: SessionFormatEvent = { type: 'assistant/attempt', seq: 0, time: 300, data: { turn: 1, step: 1, stream: jsonStream(bare) } }
    expect(migrate([attempt]).events[0]!.data).toEqual({ turn: 1, step: 1, firstTokenTime: 120 })
  })

  it('preserves every other event byte-identically', () => {
    const rows: SessionFormatEvent[] = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'plugin:external/record', seq: 1, time: 2, ignorable: true, data: { retained: [1, 2, 3] } },
      { type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const before = structuredClone(rows)
    expect(migrate(rows).events).toEqual(rows)
    expect(rows).toEqual(before)
  })

  it('keeps sequence numbers and the inherited cut supplied by the decoder', () => {
    const seeded = { ...header, isSeeded: true }
    const rows: SessionFormatEvent[] = [
      settlement(0),
      { type: 'session/end-seed', seq: 1, time: 400, data: { inherited: true } },
    ]
    const result = migrate(rows, seeded, 1)
    expect(result.cut).toBe(1)
    expect(result.events.map(event => event.seq)).toEqual([0, 1])
  })

  it('derives an inherited cut unavailable before EOF from the seed marker', () => {
    const seeded = { ...header, isSeeded: true }
    const rows: SessionFormatEvent[] = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'session/end-seed', seq: 1, time: 2, data: { inherited: true } },
      settlement(2),
    ]
    expect(migrate(rows, seeded).cut).toBe(1)
  })

  it('keeps stage state independent across concurrent artifacts', () => {
    const first = stage()
    const second = stage()
    const firstOutput = new SessionFormatEventCollector()
    const secondOutput = new SessionFormatEventCollector()
    first.transformEvent(settlement(0), firstOutput)
    second.transformEvent(settlement(0), secondOutput)
    expect(firstOutput.values[0]!.data).toEqual(secondOutput.values[0]!.data)
    expect(first.finish(firstOutput)).toBe(0)
    expect(second.finish(secondOutput)).toBe(0)
  })

  it('refuses a settlement payload without a stream array', () => {
    const malformed: SessionFormatEvent = {
      type: 'assistant/message', seq: 0, time: 1, data: { turn: 1, step: 1, message },
    }
    expect(() => migrate([malformed])).toThrow()
  })

  it('refuses a settlement stream that fails released admission', () => {
    expect(() => migrate([settlement(0, { stream: [{ type: 'bogus' }] })])).toThrow()
  })


  it('transforms compact runs through the same settlement admission', () => {
    const current = stage()
    const output = new SessionFormatEventCollector()
    const run = { runType: 'plugin:test/run', firstSeq: 0, eventCount: 1, expand: () => [settlement(0)] }
    current.transformRun(run, output)
    expect(output.values).toHaveLength(1)
    expect(Object.hasOwn(payload(output.values[0]!), 'stream')).toBe(false)
  })

  it('refuses an inherited seed marker on an unseeded Session', () => {
    const marker: SessionFormatEvent = { type: 'session/end-seed', seq: 0, time: 1, data: { inherited: true } }
    expect(() => migrate([marker])).toThrow('unseeded Session contains an inherited end-seed marker')
  })

  it('requires a seeded Session to expose its inherited seed marker', () => {
    expect(() => migrate([], { ...header, isSeeded: true })).toThrow('lacks its inherited end-seed marker')
  })

  it('refuses an inherited cut that disagrees with the source marker', () => {
    const seeded = { ...header, isSeeded: true }
    const rows: SessionFormatEvent[] = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'session/end-seed', seq: 1, time: 2, data: { inherited: true } },
    ]
    expect(() => migrate(rows, seeded, 0)).toThrow('inherited cut disagrees with its source marker')
  })

  it('omits attempt first-token latency when the stream carries no token', () => {
    const tokenless: readonly AssistantStreamRecord[] = [
      { type: 'chunk', time: 100, chunk: { type: 'usage', usage } },
    ]
    const attempt: SessionFormatEvent = { type: 'assistant/attempt', seq: 0, time: 300, data: { turn: 1, step: 1, stream: jsonStream(tokenless) } }
    expect(migrate([attempt]).events[0]!.data).toEqual({ turn: 1, step: 1, usage })
  })

  it('keeps a message without usage or interruption free of those fields', () => {
    const data = payload(migrate([settlement(0, { usage: undefined, interrupted: undefined })]).events[0]!)
    expect(Object.hasOwn(data, 'usage')).toBe(false)
    expect(Object.hasOwn(data, 'interrupted')).toBe(false)
  })

  it('refuses a non-object settlement payload and a missing required field', () => {
    expect(() => migrate([{ type: 'assistant/message', seq: 0, time: 1, data: 4 }])).toThrow('payload must be an object')
    expect(() => migrate([{ type: 'assistant/message', seq: 0, time: 1, data: { turn: 1, step: 1, stream: jsonStream(stream) } }]))
      .toThrow('lacks required field message')
  })

  it('refuses unexpected settlement fields', () => {
    expect(() => migrate([settlement(0, { unexpected: 1 })])).toThrow()
  })
})
