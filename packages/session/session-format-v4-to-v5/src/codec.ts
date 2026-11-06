/** V5 physical codec: released V4 framing with assistant-stream-free settlement rows. */

import { SessionFormatError, isSessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import type {
  SessionFormatCodec,
  SessionFormatCurrentEncoder,
  SessionFormatEvent,
  SessionFormatHeader,
  SessionFormatMigrationContext,
  SessionFormatRecovery,
} from '@deepseek-ai/dsh-session-format'
import { releasedV4SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { assertReleasedV5Header, assertReleasedV5Settlement } from './validation.ts'

function physicalV4(value: unknown): SessionFormatHeader {
  if (!isSessionFormatJsonObject(value) || value['version'] !== 5) {
    throw new SessionFormatError('expected format v5 physical header')
  }
  return { ...value, version: 4 } as SessionFormatHeader
}

/** V5 physical encoder and decoder over the released V4 row framing. */
export const releasedV5SessionFormatCodec = Object.freeze({
  version: 5,
  decodeHeader(value: unknown) {
    const decoded = releasedV4SessionFormatCodec.decodeHeader(physicalV4(value))
    return { ...decoded, version: 5 }
  },
  createDecoder(value: unknown, recovery: SessionFormatRecovery) {
    const decoder = releasedV4SessionFormatCodec.createDecoder(physicalV4(value), recovery)
    return {
      ...decoder,
      header: { ...decoder.header, version: 5 },
      decodeRow(row: unknown, context: SessionFormatMigrationContext) {
        if (isSessionFormatJsonObject(row) && typeof row['type'] === 'string') {
          assertReleasedV5Settlement(row['type'], row['data'])
        }
        decoder.decodeRow(row, {
          emitEvent: context.emitEvent.bind(context),
          emitRun: context.emitRun.bind(context),
        })
      },
    }
  },
  encodeHeader(header: SessionFormatHeader, inheritedEventCount: number) {
    assertReleasedV5Header(header)
    return { ...releasedV4SessionFormatCodec.encodeHeader({ ...header, version: 4 }, inheritedEventCount), version: 5 }
  },
  encodeEvent(event: SessionFormatEvent) {
    assertReleasedV5Settlement(event.type, event.data)
    return releasedV4SessionFormatCodec.encodeEvent(event)
  },
}) satisfies SessionFormatCodec & SessionFormatCurrentEncoder
