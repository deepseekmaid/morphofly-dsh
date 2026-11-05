/** V2 history records become one event-shaped Client value per wire record. */

import { describe, expect, it } from 'vitest'
import type { SessionHistoryRecord } from '../src/types.ts'
import {
  historyEntries,
  historyRecordFirstSeq,
  historyRecordLastSeq,
} from '../src/client/sessions/history-records.ts'

describe('Session history record projection', () => {
  it('retains an ordinary event and its point cursor', () => {
    const ordinary: SessionHistoryRecord = {
      type: 'event',
      event: { type: 'turn/start', seq: 7, time: 1, data: { turn: 1 } },
    }

    const records = [ordinary]
    const [entry] = historyEntries(records)

    expect(historyEntries(records)).toBe(records)
    expect(entry).toBe(ordinary)
    expect(historyRecordFirstSeq(ordinary)).toBe(7)
    expect(entry?.event.time).toBe(1)
    expect(historyRecordLastSeq(ordinary)).toBe(7)
  })

  it('retains one settlement message without an embedded stream', () => {
    const message: SessionHistoryRecord = {
      type: 'event',
      event: {
        type: 'assistant/message',
        seq: 11,
        time: 20,
        data: {
          turn: 1,
          step: 2,
          message: {
            id: 'message-1',
            role: 'assistant',
            content: [{ type: 'text', text: 'abcd' }],
            source: { kind: 'model', provider: 'fixture', model: 'fixture-v2' },
          },
          usage: { inputTokens: 5, outputTokens: 2 },
        },
      },
    }

    const [entry] = historyEntries([message])
    if (entry?.type !== 'event') throw new Error('expected v2 history entry')
    const { event } = entry

    expect(entry).toBe(message)
    expect(event).toBe(message.event)
    expect(historyRecordFirstSeq(message)).toBe(11)
    expect(event.time).toBe(20)
    expect(historyRecordLastSeq(message)).toBe(11)
  })

  it('retains a settlement attempt with its first-token scalar and usage', () => {
    const attempt: SessionHistoryRecord = {
      type: 'event',
      event: {
        type: 'assistant/attempt',
        seq: 20,
        time: 200,
        data: {
          turn: 2,
          step: 4,
          firstTokenTime: 180,
          usage: { inputTokens: 7, outputTokens: 1 },
        },
      },
    }

    const [entry] = historyEntries([attempt])
    if (entry?.type !== 'event') throw new Error('expected v2 history entry')
    const { event } = entry

    if (event.type !== 'assistant/attempt') throw new Error('expected Assistant attempt event')
    expect(event).toBe(attempt.event)
    expect(event.data.firstTokenTime).toBe(180)
    expect(event.data.usage).toEqual({ inputTokens: 7, outputTokens: 1 })
    expect(historyRecordLastSeq(attempt)).toBe(20)
  })
})
