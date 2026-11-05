/**
 * Sidecar storage for compact Assistant stream records.
 *
 * A format V5 Assistant settlement keeps its timing data out of the session
 * log: one immutable file per settled event stores its `AssistantStreamRecord[]`
 * as a single JSON line under `<sessionDir>/streams.v1/`. Publication writes and
 * fsyncs a temporary file, then publishes it under the final name, so a reader
 * observes either the complete file or no file at all. An existing file at the
 * same sequence is reused only when its decompressed bytes match; any other
 * difference is a conflict.
 *
 * @module dsh-session-persistence-jsonl/streams
 */

import { randomBytes } from 'node:crypto'
import { link, mkdir, open, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expandAssistantStream } from '@deepseek-ai/dsh-llm'
import type { AssistantStreamRecord } from '@deepseek-ai/dsh-llm'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import { logSuffix, type JsonlCompression } from './format.ts'
import { ensureDurableDirectoryWin32, publishNewFileWin32 } from './win32.ts'
import { compressZstdFrame, decompressZstdFrame } from './zstd.ts'

/** Directory, inside one Session directory, that holds Assistant stream sidecars. */
export const ASSISTANT_STREAM_DIRECTORY = 'streams.v1'

/** Existing sidecar whose decompressed bytes disagree with an attempted write. */
export class AssistantStreamConflictError extends Error {
  /**
   * Record the conflicting sidecar path.
   * @param path - sidecar path that already holds different content.
   * @param options - optional cause when the existing file cannot be decoded.
   */
  constructor(path: string, options?: ErrorOptions) {
    super(`Assistant stream sidecar ${path} already holds different content`, options)
    this.name = 'AssistantStreamConflictError'
  }
}

/** Sidecar whose stored bytes cannot be decoded into an Assistant stream. */
export class AssistantStreamCorruptError extends Error {
  /**
   * Record the corrupt sidecar path and the check that rejected it.
   * @param path - sidecar path that failed validation.
   * @param detail - the check that rejected the stored bytes.
   * @param options - optional cause for a decode failure.
   */
  constructor(path: string, detail: string, options?: ErrorOptions) {
    super(`Assistant stream sidecar ${path} ${detail}`, options)
    this.name = 'AssistantStreamCorruptError'
  }
}

/**
 * The sidecar directory owned by one Session directory.
 * @param sessionDir - the Session directory that owns its sidecars.
 * @returns the sidecar directory path.
 */
export function assistantStreamDirectory(sessionDir: string): string {
  return join(sessionDir, ASSISTANT_STREAM_DIRECTORY)
}

/**
 * The sidecar filename for one settled Assistant event.
 * @param seq - non-negative safe Session event sequence.
 * @param compression - configured sidecar encoding.
 * @returns the sequence-named filename with its encoding suffix.
 * @throws {TypeError} when `seq` is not a non-negative safe integer.
 */
export function assistantStreamFilename(seq: SessionSeq, compression: JsonlCompression): string {
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new TypeError(`Assistant stream sequence must be a non-negative safe integer, got ${String(seq)}`)
  }
  return `s${seq}${logSuffix(compression)}`
}

/**
 * Persist one settled Assistant event's compact stream as an immutable sidecar.
 * An existing sidecar for the same sequence is reused when its decompressed
 * bytes match and rejected as a conflict otherwise. The caller appends the
 * event's log line only after this resolves, so a log line never precedes its
 * stream.
 * @param sessionDir - the Session directory that owns its sidecars.
 * @param seq - the settled Assistant event's sequence.
 * @param stream - compact records produced for this settlement.
 * @param compression - configured sidecar encoding.
 * @returns nothing after the sidecar is durable.
 * @throws {AssistantStreamConflictError} when the sequence already holds different content.
 */
export async function writeAssistantStream(
  sessionDir: string,
  seq: SessionSeq,
  stream: readonly AssistantStreamRecord[],
  compression: JsonlCompression,
): Promise<void> {
  const directory = assistantStreamDirectory(sessionDir)
  const path = join(directory, assistantStreamFilename(seq, compression))

  /* v8 ignore next -- platform dispatch: each coverage lane can execute only its own durability peer. */
  if (process.platform === 'win32') {
    await ensureDurableDirectoryWin32(directory)
  } else {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await syncDirectoryPosix(dirname(directory))
  }

  const plaintext = encodeAssistantStream(seq, stream)
  const content = compression === 'zstd' ? await compressZstdFrame(plaintext) : plaintext
  const temporary = await writeSyncedTempFile(path, content)
  try {
    /* v8 ignore next -- platform dispatch: each coverage lane can execute only its own durability peer. */
    if (process.platform === 'win32') {
      await publishNewFileWin32(temporary, path)
    } else {
      await link(temporary, path)
      await syncDirectoryPosix(directory)
    }
  } catch (error) {
    /* v8 ignore next -- non-EEXIST publish failures are external I/O faults, propagated unchanged. */
    if (!isErrno(error, 'EEXIST')) throw error
    await assertReusableAssistantStream(path, plaintext, compression)
  } finally {
    await rm(temporary, { force: true })
  }
}

/**
 * Read one settled Assistant event's compact stream records.
 * @param sessionDir - the Session directory that owns its sidecars.
 * @param seq - the settled Assistant event's sequence.
 * @param compression - expected sidecar encoding.
 * @returns the stored records, or `undefined` when no sidecar exists.
 * @throws {AssistantStreamCorruptError} when the sidecar exists but cannot be decoded or validated.
 */
export async function readAssistantStream(
  sessionDir: string,
  seq: SessionSeq,
  compression: JsonlCompression,
): Promise<readonly AssistantStreamRecord[] | undefined> {
  const path = join(assistantStreamDirectory(sessionDir), assistantStreamFilename(seq, compression))
  let bytes: Buffer
  try {
    bytes = await readFile(path)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined
    throw error
  }
  let plaintext: Buffer
  try {
    plaintext = await decodeAssistantStream(bytes, compression)
  } catch (error) {
    throw new AssistantStreamCorruptError(path, 'is not a decodable Zstandard frame', { cause: error })
  }
  return parseAssistantStream(path, plaintext, seq)
}

/** Encode one sidecar line with a fixed key order and the log's trailing newline. */
function encodeAssistantStream(seq: SessionSeq, stream: readonly AssistantStreamRecord[]): Buffer {
  return Buffer.from(`${JSON.stringify({ seq, stream })}\n`, 'utf8')
}

/** Decode a sidecar's physical bytes into its JSONL plaintext. */
async function decodeAssistantStream(bytes: Buffer, compression: JsonlCompression): Promise<Buffer> {
  return compression === 'zstd' ? await decompressZstdFrame(bytes) : bytes
}

/** Parse and fully validate one sidecar line against its expected sequence. */
function parseAssistantStream(
  path: string,
  plaintext: Buffer,
  seq: SessionSeq,
): readonly AssistantStreamRecord[] {
  let value: unknown
  try {
    value = JSON.parse(plaintext.toString('utf8'))
  } catch (error) {
    throw new AssistantStreamCorruptError(path, 'is not valid JSON', { cause: error })
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AssistantStreamCorruptError(path, 'is not a JSON object')
  }
  const record = value as { seq?: unknown; stream?: unknown }
  if (record.seq !== seq) {
    throw new AssistantStreamCorruptError(path, `records sequence ${String(record.seq)} instead of ${String(seq)}`)
  }
  if (!Array.isArray(record.stream)) {
    throw new AssistantStreamCorruptError(path, 'has no Assistant stream array')
  }
  const stream = record.stream as readonly AssistantStreamRecord[]
  try {
    expandAssistantStream(stream)
  } catch (error) {
    throw new AssistantStreamCorruptError(path, 'holds an invalid Assistant stream', { cause: error })
  }
  return stream
}

/** Reuse an existing sidecar only when its decompressed bytes equal this write. */
async function assertReusableAssistantStream(
  path: string,
  plaintext: Buffer,
  compression: JsonlCompression,
): Promise<void> {
  const existing = await readFile(path)
  let existingPlaintext: Buffer
  try {
    existingPlaintext = await decodeAssistantStream(existing, compression)
  } catch (error) {
    throw new AssistantStreamConflictError(path, { cause: error })
  }
  if (!existingPlaintext.equals(plaintext)) throw new AssistantStreamConflictError(path)
}

/** Write `content` to a synced sibling temp file and return its path. */
async function writeSyncedTempFile(path: string, content: Buffer): Promise<string> {
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(content)
    await handle.sync()
  } finally {
    await handle.close()
  }
  return temporary
}

/** fsync one POSIX directory so a just-created entry is crash-durable. */
/* v8 ignore start -- Node exposes no directory fsync on Windows; the Windows peer uses write-through namespace publication. */
async function syncDirectoryPosix(directory: string): Promise<void> {
  const handle = await open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
/* v8 ignore stop */

/** Whether one filesystem failure carries the given errno code. */
function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code
}
