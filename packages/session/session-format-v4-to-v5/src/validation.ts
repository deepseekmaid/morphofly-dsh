/** Native V5 Session metadata and artifact validation. */

import {
  SessionFormatError,
  isSessionFormatJsonObject,
  sessionFormatCount,
} from '@deepseek-ai/dsh-session-format'
import type { SessionFormatArtifact, SessionFormatEvent } from '@deepseek-ai/dsh-session-format'
import { assertReleasedV4Header, restoreReleasedV4Artifact } from '@deepseek-ai/dsh-session-format-v3-to-v4'

/** Published V5 settlement payloads: the stream moved to a Session-local sidecar. */
const SETTLEMENT_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  'assistant/message': new Set(['turn', 'step', 'message', 'usage', 'interrupted', 'firstTokenTime']),
  'assistant/attempt': new Set(['turn', 'step', 'usage']),
}

/**
 * Validate the exact native V5 logical header.
 * @param header - decoded or otherwise untrusted V5 Session header candidate.
 */
export function assertReleasedV5Header(header: unknown): void {
  if (!isSessionFormatJsonObject(header) || header['version'] !== 5) {
    throw new SessionFormatError('expected format v5 header')
  }
  const { version: _version, ...rest } = header
  assertReleasedV4Header({ ...rest, version: 4 })
}

/**
 * Validate one V5 settlement payload and refuse a payload that still embeds the stream.
 * @param type - decoded event type.
 * @param data - decoded event payload.
 */
export function assertReleasedV5Settlement(type: string, data: unknown): void {
  const allowed = SETTLEMENT_FIELDS[type]
  if (allowed === undefined) return
  if (!isSessionFormatJsonObject(data)) throw new SessionFormatError(`format v5 ${type} data must be an object`)
  if (Object.hasOwn(data, 'stream')) throw new SessionFormatError(`format v5 ${type} carries an embedded assistant stream`)
  const unexpected = Object.keys(data).find(key => !allowed.has(key))
  if (unexpected !== undefined) {
    throw new SessionFormatError(`format v5 ${type} has unexpected field ${JSON.stringify(unexpected)}`)
  }
  if (type === 'assistant/message' && data['firstTokenTime'] !== undefined) {
    sessionFormatCount(data['firstTokenTime'], 'format v5 assistant/message firstTokenTime')
  }
  if (type === 'assistant/attempt' && data['usage'] !== undefined) {
    assertReleasedV5Usage(data['usage'])
  }
}

/**
 * Validate one known-type V5 logical event.
 * @param event - decoded V5 event whose payload is understood by the installed Session package.
 */
export function assertReleasedV5EventPayload(event: SessionFormatEvent): void {
  assertReleasedV5Settlement(event.type, event.data)
}

function assertReleasedV5Usage(usage: unknown): void {
  if (!isSessionFormatJsonObject(usage)) throw new SessionFormatError('format v5 assistant/attempt usage must be an object')
  sessionFormatCount(usage['inputTokens'], 'format v5 assistant/attempt usage inputTokens')
  sessionFormatCount(usage['outputTokens'], 'format v5 assistant/attempt usage outputTokens')
}

/**
 * Validate one complete V5 artifact through the released V4 restorer plus V5 payload admission.
 * @param artifact - complete detached V5 artifact.
 * @param knownEventTypes - event types understood by the installed Session package.
 * @returns the same validated artifact and event objects.
 */
export function restoreReleasedV5Artifact(
  artifact: SessionFormatArtifact,
  knownEventTypes: ReadonlySet<string>,
): SessionFormatArtifact {
  assertReleasedV5Header(artifact.header)
  const restored = restoreReleasedV4Artifact({
    ...artifact,
    header: { ...artifact.header, version: 4 },
  }, knownEventTypes)
  for (const event of restored.events) {
    if (knownEventTypes.has(event.type)) assertReleasedV5EventPayload(event)
  }
  return { ...restored, header: artifact.header }
}
