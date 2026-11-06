/**
 * Committed Assistant-stream sidecar fixtures for Session V5.
 *
 * Session V5 keeps each settlement's exact compact stream in Session-local
 * `streams.v1/` storage instead of the event log. A recorded-session snapshot
 * commits those streams next to its Session fixture as
 * `session[.<n>][.vN].streams.jsonl`, one `{ seq, stream }` line per settlement,
 * so replay can reconstruct the recorded model calls without the original
 * Session directory.
 *
 * Only the current writer generation writes this file. Fully historical
 * generations keep their embedded stream rows and never get a sidecar.
 *
 * @module @deepseek-ai/dsh-session-snapshot/assistant-streams
 */

import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import {
  formatAssistantStreamFixture,
  parseAssistantStreamFixture,
  type AssistantStreamFixtureEntry,
  type AssistantStreamRecord,
} from '@deepseek-ai/dsh-llm-replay'
import { normalizeAssistantStreamFixture, type NormalizeContext } from './normalize.ts'
import { parseSessionFixtureName, sessionStreamFixtureName } from './session-files.ts'

/** Session-local directory the JSONL backend publishes sidecars into. */
export const ASSISTANT_STREAM_DIRECTORY = 'streams.v1'

/** One string replacement applied before a refreshed fixture is normalized. */
export interface AssistantStreamReplacement {
  /** Volatile value the fresh run produced. */
  readonly from: string
  /** Stable committed value it must read as. */
  readonly to: string
}

const ASSISTANT_STREAM_FILE = /^s(\d+)\.jsonl$/u

/**
 * Harvest one Session directory's committed sidecar streams.
 *
 * @param sessionDir - Directory holding the Session's own log generation.
 * @returns Streams keyed by settlement sequence, or `undefined` when the
 *   Session has no sidecar directory (a historical generation).
 */
export async function harvestAssistantStreams(
  sessionDir: string,
): Promise<ReadonlyMap<number, readonly AssistantStreamRecord[]> | undefined> {
  let files: string[]
  try {
    files = await readdir(join(sessionDir, ASSISTANT_STREAM_DIRECTORY))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const entries: AssistantStreamFixtureEntry[] = []
  for (const file of files.sort()) {
    const match = ASSISTANT_STREAM_FILE.exec(file)
    if (match === null) continue
    const seq = Number(match[1])
    const parsed = parseAssistantStreamFixture(
      await readFile(join(sessionDir, ASSISTANT_STREAM_DIRECTORY, file), 'utf8'),
      join(ASSISTANT_STREAM_DIRECTORY, file),
    )
    const stream = parsed.get(seq)
    if (stream === undefined) throw new Error(`${file}: sidecar does not name its own settlement seq`)
    entries.push({ seq, stream })
  }
  return entries.length === 0 ? undefined : new Map(entries.map(entry => [entry.seq, entry.stream]))
}

/**
 * Render one role's harvested streams as a committed sidecar fixture.
 *
 * @param streams - Streams keyed by settlement sequence.
 * @param ctx - Run values to scrub.
 * @param replacements - Optional refresh replacements applied before scrubbing.
 * @returns Normalized sidecar fixture text.
 */
export function renderAssistantStreamFixture(
  streams: ReadonlyMap<number, readonly AssistantStreamRecord[]>,
  ctx: NormalizeContext,
  replacements: readonly AssistantStreamReplacement[] = [],
): string {
  const rendered = formatAssistantStreamFixture(
    [...streams].map(([seq, stream]): AssistantStreamFixtureEntry => ({ seq, stream })),
  )
  const stable = replacements.reduce(
    (text, replacement) => text.split(replacement.from).join(replacement.to),
    rendered,
  )
  return normalizeAssistantStreamFixture(`${stable}\n`, ctx)
}

/**
 * Write the committed sidecar for one current-generation Session fixture role.
 *
 * @param scenarioDir - Owning scenario directory.
 * @param index - Parent `0` or a positive child/ordinal slot.
 * @param version - Session format generation of the fixture being written.
 * @param streams - Streams harvested from the run's Session directory.
 * @param ctx - Run values to scrub.
 * @param replacements - Optional refresh replacements.
 * @returns The written sidecar basename, or `undefined` when no sidecar applies.
 */
export async function writeAssistantStreamFixture(
  scenarioDir: string,
  index: number,
  version: number,
  streams: ReadonlyMap<number, readonly AssistantStreamRecord[]> | undefined,
  ctx: NormalizeContext,
  replacements: readonly AssistantStreamReplacement[] = [],
): Promise<string | undefined> {
  if (streams === undefined || version !== SESSION_FORMAT_VERSION) return undefined
  const name = sessionStreamFixtureName(index, version)
  await writeFile(join(scenarioDir, name), renderAssistantStreamFixture(streams, ctx, replacements))
  return name
}

/**
 * Whether one projected Session fixture text carries an Assistant settlement row.
 * @param content - projected Session fixture text, one JSON row per line.
 * @returns whether any row is an `assistant/message` or `assistant/attempt` event.
 */
export function sessionFixtureHasAssistantSettlement(content: string): boolean {
  for (const line of content.split('\n')) {
    if (line.trim().length === 0) continue
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch (error) {
      throw new Error('session fixture line contains invalid JSON', { cause: error })
    }
    if (record === null || typeof record !== 'object' || Array.isArray(record)) continue
    const type = (record as { type?: string }).type
    if (type === 'assistant/message' || type === 'assistant/attempt') return true
  }
  return false
}

/**
 * Require every current-generation fixture with settlements to commit its sidecar.
 *
 * @param dir - Scenario directory.
 * @param files - File basenames in that directory.
 * @param fixtureNames - Selected Session fixture basenames in role order.
 * @throws when a current-generation fixture with settlements lacks its sidecar.
 */
export async function assertAssistantStreamFixtureCoverage(
  dir: string,
  files: readonly string[],
  fixtureNames: readonly string[],
): Promise<void> {
  for (const [index, name] of fixtureNames.entries()) {
    const fixture = parseSessionFixtureName(name)
    if (fixture === undefined || fixture.version !== SESSION_FORMAT_VERSION) continue
    const content = await readFile(join(dir, name), 'utf8')
    if (!sessionFixtureHasAssistantSettlement(content)) continue
    const sidecar = sessionStreamFixtureName(index, fixture.version)
    if (!files.includes(sidecar)) {
      throw new Error(`${name}: current-generation Session fixture with Assistant settlements lacks ${sidecar}`)
    }
  }
}
