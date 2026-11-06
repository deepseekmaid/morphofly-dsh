/** Adjacent V4-to-V5 stream-sidecar migration declaration and per-artifact stage. */

import {
  SessionFormatError,
  SessionFormatUnsupportedMigrationError,
  defineSessionFormatMigration,
  isSessionFormatJsonObject,
  snapshotSessionFormatJson,
} from '@deepseek-ai/dsh-session-format'
import type {
  SessionFormatEvent,
  SessionFormatEventRun,
  SessionFormatJsonObject,
  SessionFormatJsonValue,
  SessionFormatMigration,
  SessionFormatMigrationContext,
  SessionFormatMigrationStage,
  SessionFormatMigrationStageInput,
} from '@deepseek-ai/dsh-session-format'
import { assertReleasedV4Header } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { assistantStreamFirstTokenTime, expandAssistantStream } from '@deepseek-ai/dsh-llm'
import type { AssistantStreamRecord } from '@deepseek-ai/dsh-llm'
import { assertReleasedV5Header } from './validation.ts'

/** Fields a released V4 settlement payload may carry before the stream moves out. */
const MESSAGE_FIELDS: ReadonlySet<string> = new Set(['turn', 'step', 'message', 'stream', 'usage', 'interrupted'])
/** Fields a released V4 attempt payload may carry before the stream moves out. */
const ATTEMPT_FIELDS: ReadonlySet<string> = new Set(['turn', 'step', 'stream'])

/**
 * V4-to-V5 edge: remove the embedded assistant stream from both settlement
 * events, keeping the scalar summaries the synchronous consumers fold.
 */
export const sessionFormatV4ToV5: SessionFormatMigration = defineSessionFormatMigration({
  name: '@deepseek-ai/dsh-session-format-v4-to-v5',
  fromVersion: 4,
  toVersion: 5,
  migrateHeader(header) {
    assertReleasedV4Header(header)
    return { ...header, version: 5 }
  },
  createStage(input) {
    return new ReleasedV4ToV5Stage(input)
  },
  validateTargetHeader: assertReleasedV5Header,
})

class ReleasedV4ToV5Stage implements SessionFormatMigrationStage {
  readonly headerInheritedEventCount?: number
  private readonly sourceInheritedEventCount: number | undefined
  private readonly seeded: boolean
  private derivedCut: number | undefined
  private nextSeq = 0

  constructor(input: SessionFormatMigrationStageInput) {
    this.sourceInheritedEventCount = input.sourceInheritedEventCount
    this.seeded = input.sourceHeader.isSeeded
    if (input.sourceInheritedEventCount !== undefined) this.headerInheritedEventCount = input.sourceInheritedEventCount
  }

  transformEvent(event: SessionFormatEvent, context: SessionFormatMigrationContext): void {
    if (event.type === 'session/end-seed' && isSessionFormatJsonObject(event.data)
      && event.data['inherited'] === true) {
      if (!this.seeded) {
        throw new SessionFormatError('format v4 unseeded Session contains an inherited end-seed marker')
      }
      this.derivedCut = this.nextSeq
    }
    context.emitEvent(this.migrate(event))
    this.nextSeq += 1
  }

  transformRun(run: SessionFormatEventRun, context: SessionFormatMigrationContext): void {
    for (const event of run.expand()) this.transformEvent(event, context)
  }

  finish(): number {
    if (!this.seeded) return 0
    const cut = this.derivedCut
    if (cut === undefined) {
      throw new SessionFormatError('format v4 seeded header lacks its inherited end-seed marker')
    }
    if (this.sourceInheritedEventCount !== undefined && cut !== this.sourceInheritedEventCount) {
      throw new SessionFormatError('format v4 inherited cut disagrees with its source marker')
    }
    return cut
  }

  private migrate(event: SessionFormatEvent): SessionFormatEvent {
    if (event.type === 'assistant/message') {
      return { ...event, data: migrateAssistantMessage(event) }
    }
    if (event.type === 'assistant/attempt') {
      return { ...event, data: migrateAssistantAttempt(event) }
    }
    return event
  }
}

function migrateAssistantMessage(event: SessionFormatEvent): SessionFormatJsonObject {
  const data = settlementData(event, MESSAGE_FIELDS)
  const stream = requireReleasedStream(event, data)
  const firstTokenTime = assistantStreamFirstTokenTime(stream as readonly AssistantStreamRecord[])
  const migrated: Record<string, SessionFormatJsonValue> = {}
  for (const key of ['turn', 'step', 'message'] as const) migrated[key] = requireField(event, data, key)
  if (data['usage'] !== undefined) migrated['usage'] = data['usage']
  if (data['interrupted'] !== undefined) migrated['interrupted'] = data['interrupted']
  if (firstTokenTime !== undefined) migrated['firstTokenTime'] = firstTokenTime
  return migrated
}

function migrateAssistantAttempt(event: SessionFormatEvent): SessionFormatJsonObject {
  const data = settlementData(event, ATTEMPT_FIELDS)
  const stream = requireReleasedStream(event, data)
  const migrated: Record<string, SessionFormatJsonValue> = {}
  for (const key of ['turn', 'step'] as const) migrated[key] = requireField(event, data, key)
  const usage = lastStreamUsage(stream as readonly AssistantStreamRecord[])
  if (usage !== undefined) migrated['usage'] = usage
  const firstTokenTime = assistantStreamFirstTokenTime(stream as readonly AssistantStreamRecord[])
  if (firstTokenTime !== undefined) migrated['firstTokenTime'] = firstTokenTime
  return migrated
}

function settlementData(event: SessionFormatEvent, allowed: ReadonlySet<string>): SessionFormatJsonObject {
  const data = event.data
  if (!isSessionFormatJsonObject(data)) {
    throw new SessionFormatUnsupportedMigrationError(`format v4 ${event.type} payload must be an object at seq ${event.seq}`)
  }
  const unexpected = Object.keys(data).find(key => !allowed.has(key))
  if (unexpected !== undefined) {
    throw new SessionFormatUnsupportedMigrationError(
      `format v4 ${event.type} has unexpected field ${JSON.stringify(unexpected)} at seq ${event.seq}`,
    )
  }
  return data
}

function requireField(
  event: SessionFormatEvent,
  data: SessionFormatJsonObject,
  key: string,
): SessionFormatJsonValue {
  const value = data[key]
  if (value === undefined) {
    throw new SessionFormatUnsupportedMigrationError(`format v4 ${event.type} lacks required field ${key} at seq ${event.seq}`)
  }
  return value
}

function requireReleasedStream(
  event: SessionFormatEvent,
  data: SessionFormatJsonObject,
): readonly SessionFormatJsonValue[] {
  const stream = data['stream']
  if (!Array.isArray(stream)) {
    throw new SessionFormatUnsupportedMigrationError(`format v4 ${event.type} lacks a stream array at seq ${event.seq}`)
  }
  try {
    expandAssistantStream(stream as readonly AssistantStreamRecord[])
  } catch (error: unknown) {
    /* v8 ignore next -- expandAssistantStream rejects with a TypeError per its contract; the fallback is defensive. */
    const detail = error instanceof Error ? error.message : String(error)
    throw new SessionFormatUnsupportedMigrationError(
      `format v4 ${event.type} stream is invalid at seq ${event.seq}: ${detail}`,
    )
  }
  return stream
}

function lastStreamUsage(stream: readonly AssistantStreamRecord[]): SessionFormatJsonValue | undefined {
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (record === undefined || record.type !== 'chunk' || record.chunk.type !== 'usage') continue
    return snapshotSessionFormatJson(record.chunk.usage, 'format v4 assistant/attempt usage')
  }
  return undefined
}
