import { describe, expect, it } from 'vitest'
import { SessionFormatEventCollector } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent, SessionFormatHeader } from '@deepseek-ai/dsh-session-format'
import { releasedV5SessionFormatCodec } from '../src/index.ts'

const header: SessionFormatHeader = { version: 5, id: 'identity', createdAt: 1, isSeeded: false, delegationDepth: 0 }
const physicalHeader = { type: 'session', ...header }

describe('V5 physical codec', () => {
  it('round-trips the current header at the writer version', () => {
    expect(releasedV5SessionFormatCodec.version).toBe(5)
    expect(releasedV5SessionFormatCodec.decodeHeader(physicalHeader)).toEqual(header)
    expect(releasedV5SessionFormatCodec.encodeHeader(header, 0)).toEqual(physicalHeader)
  })

  it('refuses a physical header of another generation', () => {
    expect(() => releasedV5SessionFormatCodec.decodeHeader({ ...physicalHeader, version: 4 })).toThrow()
  })

  it('refuses a V5 settlement row that still embeds a stream', () => {
    const row: SessionFormatEvent = {
      type: 'assistant/message',
      seq: 0,
      time: 1,
      data: {
        turn: 1,
        step: 1,
        message: { role: 'assistant', content: [] },
        stream: [{ type: 'chunk', time: 1, chunk: { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } } }],
      },
    }
    const decoder = releasedV5SessionFormatCodec.createDecoder(physicalHeader, 'strict')
    expect(() => decoder.decodeRow(row, new SessionFormatEventCollector())).toThrow()
  })
})
