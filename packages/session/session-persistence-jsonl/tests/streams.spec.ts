/**
 * Behavior of the V5 Assistant stream sidecar: naming, durable publication,
 * idempotent reuse, conflict detection, and corruption rejection. Every case
 * works in its own `mkdtemp` Session directory and cleans it up afterwards.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { AssistantStreamRecord } from '@deepseek-ai/dsh-llm'
import type { JsonlCompression } from '../src/format.ts'
import {
  ASSISTANT_STREAM_DIRECTORY,
  AssistantStreamConflictError,
  AssistantStreamCorruptError,
  assistantStreamDirectory,
  assistantStreamFilename,
  readAssistantStream,
  writeAssistantStream,
} from '../src/streams.ts'
import { decompressZstdFrame } from '../src/zstd.ts'

const SAMPLE_STREAM: readonly AssistantStreamRecord[] = [
  { type: 'text-chunks', time0: 1_000, index: 0, dt: [5, 7], texts: ['hel', 'lo', ' world'] },
]

const OTHER_STREAM: readonly AssistantStreamRecord[] = [
  { type: 'text-chunks', time0: 2_000, index: 0, dt: [1], texts: ['bye', ' now'] },
]

const roots: string[] = []

async function sessionRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-streams-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function sidecarPath(root: string, filename: string): string {
  return join(assistantStreamDirectory(root), filename)
}

async function readSidecarBytes(
  root: string,
  seq: number,
  compression: JsonlCompression = 'none',
): Promise<Buffer> {
  return readFile(sidecarPath(root, assistantStreamFilename(SessionSeq(seq), compression)))
}

async function writeRawSidecar(root: string, filename: string, content: string | Buffer): Promise<string> {
  const directory = assistantStreamDirectory(root)
  await mkdir(directory, { recursive: true })
  const path = join(directory, filename)
  await writeFile(path, content)
  return path
}

function recordLine(seq: number, stream: unknown): string {
  return `${JSON.stringify({ seq, stream })}\n`
}

describe('assistantStreamDirectory', () => {
  it('places sidecars in a versioned directory inside the Session directory', () => {
    expect(ASSISTANT_STREAM_DIRECTORY).toBe('streams.v1')
    expect(assistantStreamDirectory('/sessions/p/s1')).toBe(join('/sessions/p/s1', 'streams.v1'))
  })
})

describe('assistantStreamFilename', () => {
  it('names the sidecar after its sequence with the configured encoding suffix', () => {
    expect(assistantStreamFilename(SessionSeq(7), 'none')).toBe('s7.jsonl')
    expect(assistantStreamFilename(SessionSeq(0), 'zstd')).toBe('s0.jsonl.zstd')
  })

  it('rejects a negative or non-integer sequence', () => {
    expect(() => assistantStreamFilename(-1 as SessionSeq, 'none')).toThrow(/non-negative safe integer/)
    expect(() => assistantStreamFilename(1.5 as SessionSeq, 'none')).toThrow(TypeError)
  })
})

describe('writeAssistantStream and readAssistantStream', () => {
  it('round-trips a stream through a plaintext sidecar as one stable JSON line', async () => {
    const root = await sessionRoot()
    await writeAssistantStream(root, SessionSeq(3), SAMPLE_STREAM, 'none')
    const text = await readFile(sidecarPath(root, 's3.jsonl'), 'utf8')
    expect(text).toBe(recordLine(3, SAMPLE_STREAM))
    expect(text.indexOf('\n')).toBe(text.length - 1)
    await expect(readAssistantStream(root, SessionSeq(3), 'none')).resolves.toEqual(SAMPLE_STREAM)
  })

  it('round-trips a stream through a compressed sidecar', async () => {
    const root = await sessionRoot()
    await writeAssistantStream(root, SessionSeq(4), SAMPLE_STREAM, 'zstd')
    const frame = await readSidecarBytes(root, 4, 'zstd')
    expect((await decompressZstdFrame(frame)).toString('utf8')).toBe(recordLine(4, SAMPLE_STREAM))
    await expect(readAssistantStream(root, SessionSeq(4), 'zstd')).resolves.toEqual(SAMPLE_STREAM)
  })

  it('writes an empty stream so its event stays replayable', async () => {
    const root = await sessionRoot()
    await writeAssistantStream(root, SessionSeq(0), [], 'none')
    expect(await readFile(sidecarPath(root, 's0.jsonl'), 'utf8')).toBe('{"seq":0,"stream":[]}\n')
    await expect(readAssistantStream(root, SessionSeq(0), 'none')).resolves.toEqual([])
  })

  it('creates a missing Session directory before publishing', async () => {
    const parent = await sessionRoot()
    const root = join(parent, 'project', 'session')
    await writeAssistantStream(root, SessionSeq(2), SAMPLE_STREAM, 'none')
    await expect(readAssistantStream(root, SessionSeq(2), 'none')).resolves.toEqual(SAMPLE_STREAM)
  })

  // Permission bits are unenforceable on Windows; the POSIX lanes own this assertion.
  it.skipIf(process.platform === 'win32')('creates the sidecar directory with owner-only permissions', async () => {
    const root = await sessionRoot()
    await writeAssistantStream(root, SessionSeq(1), SAMPLE_STREAM, 'none')
    const info = await stat(assistantStreamDirectory(root))
    expect(info.mode & 0o777).toBe(0o700)
  })

  it('returns undefined for a sequence that has no sidecar', async () => {
    const root = await sessionRoot()
    await expect(readAssistantStream(root, SessionSeq(9), 'none')).resolves.toBeUndefined()
  })

  it('propagates a read failure other than a missing file', async () => {
    const root = await sessionRoot()
    await mkdir(sidecarPath(root, 's6.jsonl'), { recursive: true })
    const error: unknown = await readAssistantStream(root, SessionSeq(6), 'none').catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(Error)
    expect((error as NodeJS.ErrnoException).code).not.toBe('ENOENT')
    expect(error).not.toBeInstanceOf(AssistantStreamCorruptError)
  })
})

describe('immutable sidecar publication', () => {
  it('reuses an already published sidecar with identical bytes', async () => {
    const root = await sessionRoot()
    await writeAssistantStream(root, SessionSeq(5), SAMPLE_STREAM, 'zstd')
    const published = await readSidecarBytes(root, 5, 'zstd')
    await writeAssistantStream(root, SessionSeq(5), SAMPLE_STREAM, 'zstd')
    expect(await readSidecarBytes(root, 5, 'zstd')).toEqual(published)
    expect(await readdir(assistantStreamDirectory(root))).toEqual(['s5.jsonl.zstd'])
  })

  it('rejects different content for an already published sequence', async () => {
    const root = await sessionRoot()
    await writeAssistantStream(root, SessionSeq(5), SAMPLE_STREAM, 'zstd')
    const conflict = writeAssistantStream(root, SessionSeq(5), OTHER_STREAM, 'zstd')
    await expect(conflict).rejects.toBeInstanceOf(AssistantStreamConflictError)
    await expect(conflict).rejects.toHaveProperty('name', 'AssistantStreamConflictError')
    await expect(readAssistantStream(root, SessionSeq(5), 'zstd')).resolves.toEqual(SAMPLE_STREAM)
    expect(await readdir(assistantStreamDirectory(root))).toEqual(['s5.jsonl.zstd'])
  })

  it('rejects a sequence whose existing sidecar cannot be decoded', async () => {
    const root = await sessionRoot()
    await writeRawSidecar(root, 's5.jsonl.zstd', Buffer.from('not a zstandard frame'))
    await expect(writeAssistantStream(root, SessionSeq(5), SAMPLE_STREAM, 'zstd'))
      .rejects.toBeInstanceOf(AssistantStreamConflictError)
    expect(await readdir(assistantStreamDirectory(root))).toEqual(['s5.jsonl.zstd'])
  })

  it('accepts concurrent writers that publish identical content', async () => {
    const root = await sessionRoot()
    await Promise.all(Array.from(
      { length: 4 },
      async () => writeAssistantStream(root, SessionSeq(8), SAMPLE_STREAM, 'zstd'),
    ))
    await expect(readAssistantStream(root, SessionSeq(8), 'zstd')).resolves.toEqual(SAMPLE_STREAM)
    expect(await readdir(assistantStreamDirectory(root))).toEqual(['s8.jsonl.zstd'])
  })

  it('lets exactly one of two concurrent writers with different content win', async () => {
    const root = await sessionRoot()
    const results = await Promise.allSettled([
      writeAssistantStream(root, SessionSeq(9), SAMPLE_STREAM, 'zstd'),
      writeAssistantStream(root, SessionSeq(9), OTHER_STREAM, 'zstd'),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.reason).toBeInstanceOf(AssistantStreamConflictError)
    const published = await readAssistantStream(root, SessionSeq(9), 'zstd')
    expect([SAMPLE_STREAM, OTHER_STREAM]).toContainEqual(published)
    expect(await readdir(assistantStreamDirectory(root))).toEqual(['s9.jsonl.zstd'])
  })

  it('leaves no temporary files behind', async () => {
    const root = await sessionRoot()
    await writeAssistantStream(root, SessionSeq(1), SAMPLE_STREAM, 'none')
    await writeAssistantStream(root, SessionSeq(1), SAMPLE_STREAM, 'none')
    await writeAssistantStream(root, SessionSeq(2), OTHER_STREAM, 'none')
    const entries = await readdir(assistantStreamDirectory(root))
    expect(entries.some(entry => entry.endsWith('.tmp'))).toBe(false)
    expect(entries.sort()).toEqual(['s1.jsonl', 's2.jsonl'])
  })
})


describe('failed publication cleanup', () => {
  it('removes the temporary file when the temp write itself fails', async () => {
    const root = await sessionRoot()
    const probe = await open(join(root, 'probe'), 'w')
    const prototype = Object.getPrototypeOf(probe) as { writeFile: (this: unknown, data: string | Uint8Array) => Promise<void> }
    await probe.close()
    const spy = vi.spyOn(prototype, 'writeFile').mockImplementationOnce(async () => {
      throw new Error('simulated temporary write failure')
    })
    try {
      await expect(writeAssistantStream(root, SessionSeq(0), SAMPLE_STREAM, 'none'))
        .rejects.toThrow('simulated temporary write failure')
    } finally {
      spy.mockRestore()
    }
    await expect(readdir(assistantStreamDirectory(root))).resolves.toEqual([])
  })
})

describe('corrupt sidecars', () => {
  it('rejects a compressed sidecar that is not a decodable Zstandard frame', async () => {
    const root = await sessionRoot()
    await writeRawSidecar(root, 's0.jsonl.zstd', Buffer.from('not a zstandard frame'))
    const corrupt = readAssistantStream(root, SessionSeq(0), 'zstd')
    await expect(corrupt).rejects.toBeInstanceOf(AssistantStreamCorruptError)
    await expect(corrupt).rejects.toHaveProperty('name', 'AssistantStreamCorruptError')
  })

  it('rejects a sidecar that is not valid JSON', async () => {
    const root = await sessionRoot()
    await writeRawSidecar(root, 's0.jsonl', '{"seq":0,')
    await expect(readAssistantStream(root, SessionSeq(0), 'none')).rejects.toBeInstanceOf(AssistantStreamCorruptError)
  })

  it('rejects a sidecar that is not a JSON object', async () => {
    for (const [index, line] of ['42\n', 'null\n', '[]\n'].entries()) {
      const root = await sessionRoot()
      await writeRawSidecar(root, `s${index}.jsonl`, line)
      await expect(readAssistantStream(root, SessionSeq(index), 'none'))
        .rejects.toBeInstanceOf(AssistantStreamCorruptError)
    }
  })

  it('rejects a sidecar whose inner sequence differs', async () => {
    const root = await sessionRoot()
    await writeRawSidecar(root, 's3.jsonl', recordLine(4, []))
    await expect(readAssistantStream(root, SessionSeq(3), 'none'))
      .rejects.toThrow(/records sequence 4 instead of 3/)
  })

  it('rejects a sidecar without a stream array', async () => {
    const root = await sessionRoot()
    await writeRawSidecar(root, 's0.jsonl', '{"seq":0}\n')
    await expect(readAssistantStream(root, SessionSeq(0), 'none'))
      .rejects.toThrow(/no Assistant stream array/)
  })

  it('rejects a sidecar whose Assistant stream is invalid', async () => {
    const root = await sessionRoot()
    await writeRawSidecar(root, 's0.jsonl', recordLine(0, [{ type: 'bogus' }]))
    await expect(readAssistantStream(root, SessionSeq(0), 'none'))
      .rejects.toThrow(/invalid Assistant stream/)
  })
})
