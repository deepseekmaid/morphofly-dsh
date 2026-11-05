import { describe, expect, it } from 'vitest'
import type {
  SessionFormatArtifact,
  SessionFormatEvent,
  SessionFormatHeader,
} from '@deepseek-ai/dsh-session-format'
import {
  assertReleasedV5EventPayload,
  assertReleasedV5Header,
  restoreReleasedV5Artifact,
} from '../src/index.ts'

const header: SessionFormatHeader = { version: 5, id: 'identity', createdAt: 1, isSeeded: false, delegationDepth: 0 }
const ownEvent: SessionFormatEvent = { type: 'plugin:test/validation', seq: 0, time: 2, ignorable: true, data: { retained: true } }
const foreignEvent: SessionFormatEvent = { type: 'plugin:test/foreign', seq: 1, time: 3, ignorable: true, data: {} }

describe('V5 header admission', () => {
  it('accepts the exact writer header and refuses every other generation', () => {
    expect(() => assertReleasedV5Header(header)).not.toThrow()
    expect(() => assertReleasedV5Header({ ...header, version: 4 })).toThrow('expected format v5 header')
    expect(() => assertReleasedV5Header(undefined)).toThrow('expected format v5 header')
    expect(() => assertReleasedV5Header({ ...header, version: 5, extra: true })).toThrow()
  })
})

describe('V5 settlement admission', () => {
  it('ignores event types that carry no settlement payload', () => {
    expect(() => assertReleasedV5EventPayload({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } })).not.toThrow()
  })

  it('accepts stream-free settlements and their scalar summaries', () => {
    expect(() => assertReleasedV5EventPayload({
      type: 'assistant/message', seq: 0, time: 1, data: { turn: 1, step: 1, message: { role: 'assistant', content: [] }, firstTokenTime: 5 },
    })).not.toThrow()
    expect(() => assertReleasedV5EventPayload({
      type: 'assistant/attempt', seq: 0, time: 1, data: { turn: 1, step: 1, usage: { inputTokens: 1, outputTokens: 2 }, firstTokenTime: 5 },
    })).not.toThrow()
  })

  it('refuses a payload that still embeds the stream', () => {
    expect(() => assertReleasedV5EventPayload({
      type: 'assistant/message', seq: 0, time: 1, data: { turn: 1, step: 1, message: { role: 'assistant', content: [] }, stream: [] },
    })).toThrow('carries an embedded assistant stream')
  })

  it('refuses a non-object payload and unexpected fields', () => {
    expect(() => assertReleasedV5EventPayload({ type: 'assistant/attempt', seq: 0, time: 1, data: 3 })).toThrow('data must be an object')
    expect(() => assertReleasedV5EventPayload({
      type: 'assistant/attempt', seq: 0, time: 1, data: { turn: 1, step: 1, unexpected: 1 },
    })).toThrow('has unexpected field')
  })

  it('refuses invalid scalar summaries', () => {
    expect(() => assertReleasedV5EventPayload({
      type: 'assistant/message', seq: 0, time: 1, data: { turn: 1, step: 1, message: { role: 'assistant', content: [] }, firstTokenTime: -1 },
    })).toThrow('firstTokenTime must be a non-negative safe integer')
    expect(() => assertReleasedV5EventPayload({
      type: 'assistant/attempt', seq: 0, time: 1, data: { turn: 1, step: 1, firstTokenTime: 1.5 },
    })).toThrow('firstTokenTime must be a non-negative safe integer')
    expect(() => assertReleasedV5EventPayload({
      type: 'assistant/attempt', seq: 0, time: 1, data: { turn: 1, step: 1, usage: 4 },
    })).toThrow('usage must be an object')
    expect(() => assertReleasedV5EventPayload({
      type: 'assistant/attempt', seq: 0, time: 1, data: { turn: 1, step: 1, usage: { inputTokens: -1, outputTokens: 2 } },
    })).toThrow('inputTokens must be a non-negative safe integer')
  })
})

describe('V5 artifact restoration', () => {
  it('validates the header and hands every known event through V5 admission', () => {
    const artifact: SessionFormatArtifact = { header, inheritedEventCount: 0, events: [ownEvent, foreignEvent] }
    const restored = restoreReleasedV5Artifact(artifact, new Set(['plugin:test/validation']))
    expect(restored.header).toEqual(header)
    expect(restored.events).toEqual([ownEvent, foreignEvent])
  })

  it('accepts an empty artifact and refuses a foreign header generation', () => {
    expect(restoreReleasedV5Artifact({ header, inheritedEventCount: 0, events: [] }, new Set()).events).toEqual([])
    expect(() => restoreReleasedV5Artifact(
      { header: { ...header, version: 4 }, inheritedEventCount: 0, events: [] },
      new Set(),
    )).toThrow()
  })
})
