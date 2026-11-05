/**
 * Write-path commit order for the V5 Assistant stream sidecars: a settlement's
 * sidecar becomes durable before its log line, a refused batch retries without
 * duplicating either artifact, and events that carry no stream stay sidecar-free.
 * Every case mounts the backend over its own temporary storage root.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { existsSync } from 'node:fs'
import { mkdtemp, open, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { AssistantStreamRecord } from '@deepseek-ai/dsh-llm'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import SessionStore from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { JsonlCompression } from '../src/format.ts'
import { logPath, sessionDir } from '../src/format.ts'
import { assistantStreamDirectory, assistantStreamFilename, readAssistantStream } from '../src/streams.ts'

const STREAM_A: readonly AssistantStreamRecord[] = [
  { type: 'text-chunks', time0: 1_000, index: 0, dt: [2], texts: ['hel', 'lo'] },
]

const STREAM_B: readonly AssistantStreamRecord[] = [
  { type: 'text-chunks', time0: 2_000, index: 1, dt: [3], texts: [' wor', 'ld'] },
]

/** One mounted backend, its live session, and the write handle routing it. */
interface Mounted {
  readonly root: string
  readonly ctx: Context
  readonly session: Session
  readonly handle: SessionHandle
}

const mounts: Mounted[] = []

/**
 * Mount the JSONL backend and route one live session through a fresh write handle.
 * @param compression - physical encoding for both the log and its sidecars.
 * @returns the mounted fixture for one test.
 */
async function mount(compression: JsonlCompression = 'none'): Promise<Mounted> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-sidecar-'))
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root, compression })
  const session = ctx.sessions.create(SessionId('stream-sidecar'))
  const handle = await ctx.sessionPersistence.create(session.header)
  const mounted = { root, ctx, session, handle }
  mounts.push(mounted)
  return mounted
}

afterEach(async () => {
  vi.restoreAllMocks()
  const failures: unknown[] = []
  for (const mounted of mounts.splice(0)) {
    try {
      await mounted.ctx.fiber.dispose()
    } catch (error: unknown) {
      failures.push(error)
    }
    await rm(mounted.root, { recursive: true, force: true })
  }
  if (failures.length > 0) throw new AggregateError(failures, 'stream-sidecar fixture cleanup failed')
})

/**
 * Append one canonical turn whose settlements carry the given streams; the whole
 * turn lands in a single routed batch. V4 relationship validation requires each
 * settlement to sit inside an open turn and step.
 * @param mounted - the fixture whose live session receives the turn.
 * @param carried - one compact stream per settlement, in step order.
 * @returns the sequence of each carrying settlement.
 */
function appendCarryingTurn(
  mounted: Mounted,
  carried: readonly (readonly AssistantStreamRecord[])[],
): number[] {
  const settlements: number[] = []
  mounted.session.append('turn/start', { turn: 1 })
  carried.forEach((stream, index) => {
    const step = index + 1
    mounted.session.append('step/start', { turn: 1, step })
    settlements.push(mounted.session.appendWithCarry(
      'assistant/attempt',
      { turn: 1, step, stream: [] },
      { assistantStream: stream },
    ).seq)
    mounted.session.append('step/end', { turn: 1, step })
  })
  mounted.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return settlements
}

function sessionDirectory(mounted: Mounted): string {
  return sessionDir(mounted.root, mounted.session.header.cwd, mounted.session.id)
}

function sidecarDirectory(mounted: Mounted): string {
  return assistantStreamDirectory(sessionDirectory(mounted))
}

function sidecarPath(mounted: Mounted, seq: number, compression: JsonlCompression = 'none'): string {
  return join(sidecarDirectory(mounted), assistantStreamFilename(SessionSeq(seq), compression))
}

function logPathOf(mounted: Mounted, compression: JsonlCompression = 'none'): string {
  return logPath(mounted.root, mounted.session.header.cwd, mounted.session.id, compression)
}

/** Published sidecar names, ignoring crash-residue temporary files. */
async function settlementFiles(mounted: Mounted): Promise<string[]> {
  return (await readdir(sidecarDirectory(mounted))).filter(name => !name.endsWith('.tmp')).sort()
}

/** The FileHandle write entry shared by sidecar and log publication. */
type FileHandleWrite = (this: unknown, data: string | Uint8Array) => Promise<void>

/** Whether one written payload is a plaintext sidecar line (`{"seq":...}`). */
function isSidecarLine(data: string | Uint8Array): boolean {
  const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8')
  return text.startsWith('{"seq":')
}

/**
 * Reach the shared FileHandle prototype through one probe so a test can observe
 * or refuse every cross-platform write call without mocking the fs module.
 * @param mounted - the fixture whose root hosts the detached probe file.
 * @returns the prototype object whose `writeFile` every handle instance calls.
 */
async function fileHandlePrototype(mounted: Mounted): Promise<{ writeFile: FileHandleWrite }> {
  const probePath = join(mounted.root, 'prototype-probe')
  const probe = await open(probePath, 'w')
  try {
    return Object.getPrototypeOf(probe) as { writeFile: FileHandleWrite }
  } finally {
    await probe.close()
    await rm(probePath, { force: true })
  }
}

describe('sidecar write path', () => {
  it('refuses the log when a sidecar write fails, then retries both artifacts', async () => {
    const mounted = await mount()
    const prototype = await fileHandlePrototype(mounted)
    const realWrite = prototype.writeFile
    let refused = false
    const writeSpy = vi.spyOn(prototype, 'writeFile').mockImplementation(
      async function (this: unknown, data: string | Uint8Array): Promise<void> {
        if (!refused && isSidecarLine(data)) {
          refused = true
          throw new Error('simulated sidecar write failure')
        }
        return realWrite.call(this, data)
      },
    )
    const [settled] = appendCarryingTurn(mounted, [STREAM_A])
    try {
      await expect(mounted.ctx.sessions.flush(mounted.session)).rejects.toThrow(/simulated sidecar write failure/)
      expect(refused).toBe(true)
      expect(existsSync(logPathOf(mounted))).toBe(false)
      expect(existsSync(sidecarPath(mounted, settled!))).toBe(false)
    } finally {
      writeSpy.mockRestore()
    }

    await expect(mounted.ctx.sessions.flush(mounted.session)).resolves.toBe(true)
    expect(await settlementFiles(mounted)).toEqual([`s${settled!}.jsonl`])
    await expect(readAssistantStream(sessionDirectory(mounted), SessionSeq(settled!), 'none')).resolves.toEqual(STREAM_A)
    expect((await mounted.handle.read()).events.map(event => event.seq)).toEqual([0, 1, 2, 3, 4])
    expect(existsSync(logPathOf(mounted))).toBe(true)
  })

  it('rolls a refused log append back and reuses the already published sidecar on retry', async () => {
    const mounted = await mount()
    await mounted.handle.flush()
    const before = (await stat(logPathOf(mounted))).size
    const prototype = await fileHandlePrototype(mounted)
    const realWrite = prototype.writeFile
    let refused = false
    const writeSpy = vi.spyOn(prototype, 'writeFile').mockImplementation(
      async function (this: unknown, data: string | Uint8Array): Promise<void> {
        const isLogBatch = typeof data === 'string' && data.includes('"type":"assistant/attempt"')
        if (isLogBatch && !refused) {
          await realWrite.call(this, data)
          refused = true
          throw new Error('simulated append failure')
        }
        return realWrite.call(this, data)
      },
    )
    const [settled] = appendCarryingTurn(mounted, [STREAM_A])
    try {
      await expect(mounted.ctx.sessions.flush(mounted.session)).rejects.toThrow(/simulated append failure/)
      expect(refused).toBe(true)
      expect((await stat(logPathOf(mounted))).size).toBe(before)
      await expect(readAssistantStream(sessionDirectory(mounted), SessionSeq(settled!), 'none')).resolves.toEqual(STREAM_A)
    } finally {
      writeSpy.mockRestore()
    }

    const published = await stat(sidecarPath(mounted, settled!))
    await expect(mounted.ctx.sessions.flush(mounted.session)).resolves.toBe(true)
    if (process.platform !== 'win32') {
      expect((await stat(sidecarPath(mounted, settled!))).ino).toBe(published.ino)
    }
    expect(await settlementFiles(mounted)).toEqual([`s${settled!}.jsonl`])
    expect(await readdir(sidecarDirectory(mounted))).toHaveLength(1)
    expect((await mounted.handle.read()).events.map(event => event.seq)).toEqual([0, 1, 2, 3, 4])
  })

  it('publishes the first-batch sidecars before the materialized log appears', async () => {
    const mounted = await mount()
    const [settled] = appendCarryingTurn(mounted, [STREAM_A])
    const prototype = await fileHandlePrototype(mounted)
    const realWrite = prototype.writeFile
    let sidecarExistedBeforeLog = false
    let logExistedBeforePublish = true
    const writeSpy = vi.spyOn(prototype, 'writeFile').mockImplementation(
      async function (this: unknown, data: string | Uint8Array): Promise<void> {
        if (typeof data === 'string' && data.startsWith('{"type":"session"')) {
          sidecarExistedBeforeLog = existsSync(sidecarPath(mounted, settled!))
          logExistedBeforePublish = existsSync(logPathOf(mounted))
        }
        return realWrite.call(this, data)
      },
    )
    try {
      await expect(mounted.ctx.sessions.flush(mounted.session)).resolves.toBe(true)
    } finally {
      writeSpy.mockRestore()
    }

    expect(sidecarExistedBeforeLog).toBe(true)
    expect(logExistedBeforePublish).toBe(false)
    expect(await settlementFiles(mounted)).toEqual([`s${settled!}.jsonl`])
  })

  it('writes every carried settlement in one batch at its own sequence', async () => {
    const mounted = await mount()
    const [first, second] = appendCarryingTurn(mounted, [STREAM_A, STREAM_B])
    await expect(mounted.ctx.sessions.flush(mounted.session)).resolves.toBe(true)

    expect(await settlementFiles(mounted)).toEqual([`s${first}.jsonl`, `s${second}.jsonl`])
    await expect(readAssistantStream(sessionDirectory(mounted), SessionSeq(first!), 'none')).resolves.toEqual(STREAM_A)
    await expect(readAssistantStream(sessionDirectory(mounted), SessionSeq((first!) + 1), 'none')).resolves.toBeUndefined()
    await expect(readAssistantStream(sessionDirectory(mounted), SessionSeq(second!), 'none')).resolves.toEqual(STREAM_B)
    expect((await mounted.handle.read()).events.map(event => event.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('writes a compressed sidecar for a compressed backend', async () => {
    const mounted = await mount('zstd')
    const [settled] = appendCarryingTurn(mounted, [STREAM_A])
    await expect(mounted.ctx.sessions.flush(mounted.session)).resolves.toBe(true)

    expect(await settlementFiles(mounted)).toEqual([`s${settled}.jsonl.zstd`])
    await expect(readAssistantStream(sessionDirectory(mounted), SessionSeq(settled!), 'zstd')).resolves.toEqual(STREAM_A)
  })

  it('leaves events without a carrier sidecar-free', async () => {
    const mounted = await mount()
    mounted.session.append('turn/start', { turn: 1 })
    mounted.session.append('step/start', { turn: 1, step: 1 })
    await expect(mounted.ctx.sessions.flush(mounted.session)).resolves.toBe(true)

    expect(existsSync(sidecarDirectory(mounted))).toBe(false)
    expect((await mounted.handle.read()).events.map(event => event.seq)).toEqual([0, 1])
  })
})
