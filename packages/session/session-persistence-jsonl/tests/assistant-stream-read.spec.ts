/**
 * On-demand Assistant stream access for the V5 sidecars: a current settlement
 * reads its sidecar, a handle opened over a released V4 generation falls back
 * to that generation's embedded row, and the write-open migration tees the
 * source streams into sidecars before publishing the V5 successor.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { MessageId, type AssistantStreamRecord } from '@deepseek-ai/dsh-llm'
import {
  SessionAssistantStreamUnavailableError,
  type SessionHandle,
} from '@deepseek-ai/dsh-session-persistence'
import SessionStore from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { generationLogPath, sessionDir } from '../src/format.ts'
import { compressZstdFrame } from '../src/zstd.ts'
import { readAssistantStream } from '../src/streams.ts'
import { oneTurnLog } from '../../session-persistence/tests/contract.ts'

const STREAM: readonly AssistantStreamRecord[] = [
  { type: 'text-chunks', time0: 3, index: 0, dt: [1], texts: ['he', 'llo'] },
  { type: 'chunk', time: 5, chunk: { type: 'finish', reason: { kind: 'stop' } } },
]

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-assistant-stream-'))
  roots.push(root)
  return root
}

async function mount(root: string): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  return ctx
}

/** The provider's on-demand stream reader; the JSONL backend always exposes this capability. */
function streamReader(handle: SessionHandle): NonNullable<SessionHandle['readAssistantStream']> {
  const read = handle.readAssistantStream
  if (read === undefined) throw new Error('JSONL session handle exposes no readAssistantStream')
  return read.bind(handle)
}

/** Append one carrying turn; returns the settlement sequence. */
function appendCarryingTurn(
  session: ReturnType<Context['sessions']['create']>,
  stream: readonly AssistantStreamRecord[],
): number {
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const settlement = session.appendWithCarry('assistant/message', {
    turn: 1, step: 1,
    message: {
      id: MessageId('assistant'), role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    },
    firstTokenTime: 3,
  }, { assistantStream: stream }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return settlement.seq
}

/** Write one released V4 generation whose settlement still embeds its stream. */
async function writeV4Generation(root: string, id: SessionId): Promise<string> {
  const path = generationLogPath(root, undefined, id, 4, 'none')
  const rows = [
    { type: 'session', version: 4, id, createdAt: 1, isSeeded: false, delegationDepth: 0 },
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', seq: 2, time: 5, surfaceOp: 'append', data: {
      turn: 1, step: 1,
      message: {
        id: 'assistant', role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      },
      stream: STREAM,
    } },
    { type: 'step/end', seq: 3, time: 6, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 4, time: 7, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, rows.map(row => `${JSON.stringify(row)}\n`).join(''))
  return path
}

/** Decoded rows of one plaintext generation. */
async function generationRows(path: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(path, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
}

describe('SessionHandle.readAssistantStream', () => {
  it('reads a current settlement sidecar and returns undefined for other events', async () => {
    const root = await freshRoot()
    const ctx = await mount(root)
    const session = ctx.sessions.create(SessionId('current'))
    const handle = await ctx.sessionPersistence.create(session.header)
    let settled: number
    try {
      settled = appendCarryingTurn(session, STREAM)
      await expect(ctx.sessions.flush(session)).resolves.toBe(true)
      await expect(streamReader(handle)(settled)).resolves.toEqual(STREAM)
      await expect(streamReader(handle)(SessionSeq(0))).resolves.toBeUndefined()
    } finally {
      await handle.close()
    }

    // A fresh read handle observes the same sidecar without a live producer.
    const reader = await ctx.sessionPersistence.open(session.id, 'read')
    try {
      await expect(streamReader(reader)(settled)).resolves.toEqual(STREAM)
      await expect(streamReader(reader)(SessionSeq(settled + 1))).resolves.toBeUndefined()
    } finally {
      await reader.close()
    }
  })

  it('keeps an empty settlement stream distinguishable from a missing sidecar', async () => {
    const root = await freshRoot()
    const ctx = await mount(root)
    const session = ctx.sessions.create(SessionId('empty'))
    const handle = await ctx.sessionPersistence.create(session.header)
    try {
      const settled = appendCarryingTurn(session, [])
      await expect(ctx.sessions.flush(session)).resolves.toBe(true)
      await expect(streamReader(handle)(settled)).resolves.toEqual([])
    } finally {
      await handle.close()
    }
  })

  it('refuses a settlement whose sidecar is missing', async () => {
    const root = await freshRoot()
    const ctx = await mount(root)
    const session = ctx.sessions.create(SessionId('missing'))
    const handle = await ctx.sessionPersistence.create(session.header)
    try {
      // An explicit append never carries a stream, so the settlement has no sidecar.
      await handle.append(oneTurnLog())
      await expect(streamReader(handle)(SessionSeq(3)))
        .rejects.toBeInstanceOf(SessionAssistantStreamUnavailableError)
    } finally {
      await handle.close()
    }
  })

  it('falls back to a V4 generation embedded stream on a read open', async () => {
    const root = await freshRoot()
    const id = SessionId('v4-read')
    const source = await writeV4Generation(root, id)
    const original = await readFile(source)
    const ctx = await mount(root)
    const handle = await ctx.sessionPersistence.open(id, 'read')
    try {
      expect(handle.header.version).toBe(SESSION_FORMAT_VERSION)
      await expect(streamReader(handle)(SessionSeq(2))).resolves.toEqual(STREAM)
      await expect(streamReader(handle)(SessionSeq(0))).resolves.toBeUndefined()
    } finally {
      await handle.close()
    }
    expect(await readFile(source)).toEqual(original)
    await expect(readFile(generationLogPath(root, undefined, id, SESSION_FORMAT_VERSION, 'none')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('tees a V4 generation stream into the sidecar before publishing its V5 successor', async () => {
    const root = await freshRoot()
    const id = SessionId('v4-write')
    const source = await writeV4Generation(root, id)
    const original = await readFile(source)
    const ctx = await mount(root)
    const successor = generationLogPath(root, undefined, id, SESSION_FORMAT_VERSION, 'none')
    const handle = await ctx.sessionPersistence.open(id, 'write')
    try {
      await expect(streamReader(handle)(SessionSeq(2))).resolves.toEqual(STREAM)
    } finally {
      await handle.close()
    }

    expect(await readFile(source)).toEqual(original)
    const rows = await generationRows(successor)
    const settlement = rows.find(row => row['type'] === 'assistant/message') as { data: Record<string, unknown> }
    expect(Object.hasOwn(settlement.data, 'stream')).toBe(false)
    expect(settlement.data['firstTokenTime']).toBe(3)
    const sessionDirPath = sessionDir(root, undefined, id)
    await expect(readAssistantStream(sessionDirPath, SessionSeq(2), 'none')).resolves.toEqual(STREAM)
    expect((await readdir(sessionDirPath)).sort())
      .toEqual(['session.lock', 'session.v4.jsonl', 'session.v5.jsonl', 'streams.v1'])
    expect((await stat(join(sessionDirPath, 'streams.v1', 's2.jsonl'))).isFile()).toBe(true)
  })

  it('falls back to a compressed V4 generation embedded stream', async () => {
    const root = await freshRoot()
    const id = SessionId('v4-zstd')
    const rows = [
      { type: 'session', version: 4, id, createdAt: 1, isSeeded: false, delegationDepth: 0 },
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
      { type: 'assistant/message', seq: 2, time: 5, surfaceOp: 'append', data: {
        turn: 1, step: 1,
        message: { id: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'hello' }], source: { kind: 'model', provider: 'mock', model: 'mock' } },
        stream: STREAM,
      } },
      { type: 'step/end', seq: 3, time: 6, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 4, time: 7, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const path = generationLogPath(root, undefined, id, 4, 'zstd')
    const header = `${JSON.stringify(rows[0])}\n`
    const body = rows.slice(1).map(row => `${JSON.stringify(row)}\n`).join('')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, Buffer.concat([await compressZstdFrame(header), await compressZstdFrame(body)]))
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'zstd' })
    const handle = await ctx.sessionPersistence.open(id, 'read')
    try {
      await expect(streamReader(handle)(SessionSeq(2))).resolves.toEqual(STREAM)
    } finally {
      await handle.close()
    }
  })

  it('reports an unreadable sidecar as an unavailable stream', async () => {
    const root = await freshRoot()
    const ctx = await mount(root)
    const session = ctx.sessions.create(SessionId('corrupt-sidecar'))
    const handle = await ctx.sessionPersistence.create(session.header)
    try {
      const settled = appendCarryingTurn(session, STREAM)
      await expect(ctx.sessions.flush(session)).resolves.toBe(true)
      await writeFile(join(sessionDir(root, session.header.cwd, session.id), 'streams.v1', `s${settled}.jsonl`), '{broken')
      await expect(streamReader(handle)(settled))
        .rejects.toBeInstanceOf(SessionAssistantStreamUnavailableError)
    } finally {
      await handle.close()
    }
  })

  it('reports an unreadable historical generation as an unavailable stream', async () => {
    const root = await freshRoot()
    const id = SessionId('corrupt-source')
    const source = await writeV4Generation(root, id)
    const ctx = await mount(root)
    const handle = await ctx.sessionPersistence.open(id, 'read')
    try {
      // A complete but unparsable committed row where the settlement lives.
      const rows = (await readFile(source, 'utf8')).split('\n').filter(Boolean)
      rows[3] = '{broken'
      await writeFile(source, `${rows.join('\n')}\n`)
      await expect(streamReader(handle)(SessionSeq(2)))
        .rejects.toBeInstanceOf(SessionAssistantStreamUnavailableError)
    } finally {
      await handle.close()
    }
  })

  it('reports a missing historical generation as an unavailable stream', async () => {
    const root = await freshRoot()
    const id = SessionId('missing-source')
    const source = await writeV4Generation(root, id)
    const ctx = await mount(root)
    const handle = await ctx.sessionPersistence.open(id, 'read')
    try {
      await rm(source)
      await expect(streamReader(handle)(SessionSeq(2)))
        .rejects.toBeInstanceOf(SessionAssistantStreamUnavailableError)
    } finally {
      await handle.close()
    }
  })

  it('reports a settlement row without an embedded stream as unavailable', async () => {
    const root = await freshRoot()
    const id = SessionId('streamless-source')
    const source = await writeV4Generation(root, id)
    const ctx = await mount(root)
    const handle = await ctx.sessionPersistence.open(id, 'read')
    try {
      const rows = (await readFile(source, 'utf8')).split('\n').filter(Boolean)
      const settlement = JSON.parse(rows[3] as string) as { data: Record<string, unknown> }
      delete settlement.data['stream']
      rows[3] = JSON.stringify(settlement)
      await writeFile(source, `${rows.join('\n')}\n`)
      await expect(streamReader(handle)(SessionSeq(2)))
        .rejects.toBeInstanceOf(SessionAssistantStreamUnavailableError)
    } finally {
      await handle.close()
    }
  })

  it('tees every carried settlement of a released generation', async () => {
    const root = await freshRoot()
    const id = SessionId('v4-multi')
    const path = generationLogPath(root, undefined, id, 4, 'none')
    const secondStream: readonly AssistantStreamRecord[] = [
      { type: 'text-chunks', time0: 9, index: 0, dt: [], texts: ['bye'] },
    ]
    const rows = [
      { type: 'session', version: 4, id, createdAt: 1, isSeeded: false, delegationDepth: 0 },
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
      { type: 'assistant/message', seq: 2, time: 5, surfaceOp: 'append', data: {
        turn: 1, step: 1,
        message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'hello' }], source: { kind: 'model', provider: 'mock', model: 'mock' } },
        stream: STREAM,
      } },
      { type: 'step/end', seq: 3, time: 6, data: { turn: 1, step: 1 } },
      { type: 'step/start', seq: 4, time: 7, data: { turn: 1, step: 2 } },
      { type: 'assistant/attempt', seq: 5, time: 9, data: { turn: 1, step: 2, stream: secondStream } },
      { type: 'step/end', seq: 6, time: 10, data: { turn: 1, step: 2 } },
      { type: 'turn/end', seq: 7, time: 11, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, rows.map(row => `${JSON.stringify(row)}\n`).join(''))
    const ctx = await mount(root)
    const writer = await ctx.sessionPersistence.open(id, 'write')
    await writer.close()
    const files = (await readdir(join(sessionDir(root, undefined, id), 'streams.v1'))).sort()
    expect(files).toEqual(['s2.jsonl', 's5.jsonl'])
    const dir = sessionDir(root, undefined, id)
    await expect(readAssistantStream(dir, SessionSeq(2), 'none')).resolves.toEqual(STREAM)
    await expect(readAssistantStream(dir, SessionSeq(5), 'none')).resolves.toEqual(secondStream)
  })
})
