/** Committed Assistant-stream sidecar fixtures: naming, rendering, harvesting, and coverage. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AssistantStreamAccumulator, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  assertAssistantStreamFixtureCoverage,
  harvestAssistantStreams,
  renderAssistantStreamFixture,
  sessionFixtureHasAssistantSettlement,
  writeAssistantStreamFixture,
} from '../src/assistant-streams.ts'
import {
  parseSessionStreamFixtureName,
  sessionFixtureNames,
  sessionStreamFixtureName,
  sessionStreamFixtureNames,
} from '../src/session-files.ts'

const CHUNKS: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'hi' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } },
  { type: 'finish', reason: { kind: 'stop' } },
]

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-stream-fixture-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function records(chunks: readonly StreamChunk[] = CHUNKS, time0 = 1_000) {
  const accumulator = new AssistantStreamAccumulator()
  for (const [index, chunk] of chunks.entries()) accumulator.push({ time: time0 + index, chunk })
  return accumulator.snapshot()
}

describe('Assistant-stream fixture names', () => {
  it('derives the sidecar name from the Session fixture role and generation', () => {
    expect(sessionStreamFixtureName(0, 5)).toBe('session.v5.streams.jsonl')
    expect(sessionStreamFixtureName(2, 5)).toBe('session.2.v5.streams.jsonl')
    expect(parseSessionStreamFixtureName('session.1.v5.streams.jsonl')).toMatchObject({ index: 1, version: 5 })
    expect(parseSessionStreamFixtureName('session.v5.jsonl')).toBeUndefined()
    expect(parseSessionStreamFixtureName('s2.jsonl')).toBeUndefined()
  })

  it('keeps sidecars out of Session generation selection', () => {
    expect(sessionFixtureNames(['session.v4.jsonl', 'session.v5.jsonl', 'session.v5.streams.jsonl']))
      .toEqual(['session.v5.jsonl'])
  })

  it('resolves a committed sidecar per selected role', () => {
    const names = ['session.v5.jsonl', 'session.1.v5.jsonl', 'session.1.v5.streams.jsonl', 'input.json']
    expect(sessionStreamFixtureNames(names, ['session.v5.jsonl', 'session.1.v5.jsonl']))
      .toEqual([undefined, 'session.1.v5.streams.jsonl'])
  })
})

describe('renderAssistantStreamFixture', () => {
  it('zeroes replay clocks while tokenizing the run cwd and keeping opaque values', () => {
    const cwd = join(dir, 'workspace')
    const stream = records([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      {
        type: 'block-end',
        index: 0,
        block: { type: 'reasoning', text: `read ${cwd}`, signature: '83e90500-8c2c-4361-8e9a-8d6dcca151fd' },
      },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const rendered = renderAssistantStreamFixture(new Map([[7, stream]]), { sessionIds: [], cwd })
    type FixtureMember = { time?: number; time0?: number; chunk?: { block?: { text?: string; signature?: string } } }
    const line = JSON.parse(rendered.trimEnd()) as { seq: number; stream: FixtureMember[] }
    expect(line.seq).toBe(7)
    expect(line.stream.every(member => member.time === undefined || member.time === 0)).toBe(true)
    expect(line.stream.every(member => member.time0 === undefined || member.time0 === 0)).toBe(true)
    const block = line.stream.map(member => member.chunk?.block).find(value => value?.signature !== undefined)
    expect(block?.text).toBe('read {{cwd}}')
    expect(block?.signature).toBe('83e90500-8c2c-4361-8e9a-8d6dcca151fd')
    expect(rendered.endsWith('\n')).toBe(true)
  })

  it('renders settlements in ascending seq order', () => {
    const rendered = renderAssistantStreamFixture(
      new Map([[5, records()], [2, records()]]),
      { sessionIds: [], cwd: '/tmp/workspace' },
    )
    expect(rendered.trimEnd().split('\n').map(line => (JSON.parse(line) as { seq: number }).seq)).toEqual([2, 5])
  })
})

describe('harvestAssistantStreams', () => {
  it('reads one sidecar file per settlement seq', async () => {
    await mkdir(join(dir, 'streams.v1'))
    for (const seq of [2, 5]) {
      await writeFile(
        join(dir, 'streams.v1', `s${String(seq)}.jsonl`),
        `${JSON.stringify({ seq, stream: records() })}\n`,
      )
    }
    const harvested = await harvestAssistantStreams(dir)
    expect([...(harvested?.keys() ?? [])]).toEqual([2, 5])
    expect(harvested?.get(5)).toEqual(records())
  })

  it('returns undefined for a historical generation without a sidecar directory', async () => {
    await expect(harvestAssistantStreams(dir)).resolves.toBeUndefined()
  })

  it('rejects a sidecar that names a different settlement seq', async () => {
    await mkdir(join(dir, 'streams.v1'))
    await writeFile(join(dir, 'streams.v1', 's2.jsonl'), `${JSON.stringify({ seq: 5, stream: records() })}\n`)
    await expect(harvestAssistantStreams(dir)).rejects.toThrow(/sidecar does not name its own settlement seq/)
  })
})

describe('writeAssistantStreamFixture', () => {
  it('writes the current-generation sidecar and skips historical generations', async () => {
    const ctx = { sessionIds: [], cwd: '/tmp/workspace' }
    const name = await writeAssistantStreamFixture(
      dir, 0, SESSION_FORMAT_VERSION, new Map([[2, records()]]), ctx,
    )
    expect(name).toBe(sessionStreamFixtureName(0, SESSION_FORMAT_VERSION))
    expect(await readFile(join(dir, name as string), 'utf8')).toContain('"seq":2')

    expect(await writeAssistantStreamFixture(dir, 0, SESSION_FORMAT_VERSION - 1, new Map([[2, records()]]), ctx))
      .toBeUndefined()
    expect(await writeAssistantStreamFixture(dir, 0, SESSION_FORMAT_VERSION, undefined, ctx)).toBeUndefined()
  })
})

describe('Assistant-stream fixture coverage', () => {
  const settlement = `${JSON.stringify({ type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [] } } })}\n`

  it('requires a sidecar for a current-generation fixture that carries settlements', async () => {
    const version = SESSION_FORMAT_VERSION
    const name = `session.v${String(version)}.jsonl`
    await writeFile(join(dir, name), settlement)
    expect(sessionFixtureHasAssistantSettlement(settlement)).toBe(true)
    await expect(assertAssistantStreamFixtureCoverage(dir, [name], [name]))
      .rejects.toThrow(/lacks session\.v5\.streams\.jsonl/)
    await writeFile(join(dir, sessionStreamFixtureName(0, version)), '')
    await expect(assertAssistantStreamFixtureCoverage(dir, [name, sessionStreamFixtureName(0, version)], [name]))
      .resolves.toBeUndefined()
  })

  it('does not require a sidecar for a historical generation', async () => {
    expect(sessionFixtureHasAssistantSettlement(settlement)).toBe(true)
    await expect(assertAssistantStreamFixtureCoverage(dir, ['session.v4.jsonl'], ['session.v4.jsonl']))
      .resolves.toBeUndefined()
  })
})
