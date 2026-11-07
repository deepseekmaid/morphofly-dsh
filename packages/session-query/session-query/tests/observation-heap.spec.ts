/**
 * The cold-open refusal renders byte-scale sizes when the free V8 heap is
 * already exhausted, which a real process cannot reach deterministically.
 */
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision, SessionReadOnlyError } from '@deepseek-ai/dsh-session-persistence'
import { describe, expect, it, vi } from 'vitest'
import { SessionObservationReader } from '../src/observation.ts'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionHandle, SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'

const heapLimit = vi.hoisted(() => ({ bytes: 0 }))

vi.mock('node:v8', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:v8')>()
  return {
    ...actual,
    // Only the limit is under test; the rest of the module stays real.
    getHeapStatistics: () => ({ ...actual.getHeapStatistics(), heap_size_limit: heapLimit.bytes }),
  }
})

const sessionId = SessionId('tiny-cold')

function header(): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 1, isSeeded: false, cwd: '/workspace' }
}

function events(): SessionEvent[] {
  return [{
    type: 'user/message',
    seq: SessionSeq(0),
    time: 1,
    data: createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }),
    surfaceOp: 'append',
  }]
}

describe('SessionObservationReader cold-open refusal formatting', () => {
  it('reports byte-scale sizes when the free heap is exhausted', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const opened: number[] = []
    const handle: SessionHandle = {
      id: sessionId,
      header: header(),
      inheritedEventCount: SessionLogOffset(0),
      access: 'read',
      read: () => Promise.resolve({ eventState: 'detached', events: events() }),
      append: () => Promise.reject(new SessionReadOnlyError(sessionId, 'append')),
      flush: () => Promise.reject(new SessionReadOnlyError(sessionId, 'flush')),
      close: () => Promise.resolve(),
      [Symbol.asyncDispose]: () => Promise.resolve(),
    }
    const snapshot: SessionPersistenceSnapshot = {
      header: header(),
      revision: SessionPersistenceRevision('r1'),
      // One stored byte prices eight estimated heap bytes, all of which exceed
      // the zero-byte budget a zero heap limit leaves.
      sizeBytes: 1,
    }
    ctx.provide('sessionPersistence', {
      stat: () => Promise.resolve(snapshot),
      open: () => {
        opened.push(1)
        return Promise.resolve(handle)
      },
    } as never)

    heapLimit.bytes = 0
    await expect(new SessionObservationReader(ctx).read(sessionId, { projectionMode: 'none' }))
      .rejects.toMatchObject({
        code: 'SESSION_QUERY_SESSION_TOO_LARGE',
        message: 'session "tiny-cold" is too large to open: about 8 B of heap for 1 B stored, but only 0 B of heap is free; close other Sessions or restart the host with a larger heap',
      })
    expect(opened).toHaveLength(0)
    await ctx.fiber.dispose()
  })
})
