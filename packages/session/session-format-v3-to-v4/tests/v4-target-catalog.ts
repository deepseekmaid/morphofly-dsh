/**
 * Released V4 catalog target for tests written against the V3→V4 generation.
 *
 * The current catalog chain now ends at V5. These helpers assemble the same
 * static inventory with `currentVersion: 4`, using the released V4 codec and
 * native validators, so the V3→V4 tests keep asserting released V4 artifacts
 * instead of the V5 successor the current writer would produce.
 */

import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import {
  createSessionFormatCatalog,
  type SessionFormatArtifact,
  type SessionFormatCatalog,
  type SessionFormatCatalogOptions,
  type SessionFormatJsonValue,
} from '@deepseek-ai/dsh-session-format'
import { sessionFormatCatalog as currentFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { releasedV0SessionFormatCodec, releasedV1SessionFormatCodec, sessionFormatV0ToV1 } from '@deepseek-ai/dsh-session-format-v0-to-v1'
import { releasedV2SessionFormatCodec, sessionFormatV1ToV2 } from '@deepseek-ai/dsh-session-format-v1-to-v2'
import { releasedV3SessionFormatCodec, sessionFormatV2ToV3 } from '@deepseek-ai/dsh-session-format-v2-to-v3'
import {
  assertReleasedV4Header, createSessionFormatV3ToV4, releasedV4SessionFormatCodec,
  restoreReleasedV4Artifact, sessionFormatV3ToV4,
} from '../src/index.ts'

/** Current catalog options retargeted at the released V4 generation. */
export const v4SessionFormatCatalogOptions: SessionFormatCatalogOptions = {
  currentVersion: 4,
  codecs: [
    releasedV0SessionFormatCodec,
    releasedV1SessionFormatCodec,
    releasedV2SessionFormatCodec,
    releasedV3SessionFormatCodec,
    releasedV4SessionFormatCodec,
  ],
  currentEncoder: releasedV4SessionFormatCodec,
  migrations: [
    sessionFormatV0ToV1,
    sessionFormatV1ToV2,
    sessionFormatV2ToV3,
    sessionFormatV3ToV4,
  ],
  restoreCurrent(artifact) {
    const restored = restoreReleasedV4Artifact(artifact, KNOWN_SESSION_EVENT_TYPES)
    // The released V4 catalog ran installed Session validation on top of its native
    // validators; run that same current validation over the V5 successor so
    // noncanonical envelope metadata cannot pass a V4-target restore.
    restoreV4AsCurrent(restored)
    return restored
  },
  restoreTransformedCurrent: artifact => restoreReleasedV4Artifact(artifact, KNOWN_SESSION_EVENT_TYPES),
  restoreCurrentHeader(header) {
    assertReleasedV4Header(header)
    return header
  },
}

/** V4-target catalog that restores released V4 artifacts as V4. */
export const v4SessionFormatCatalog = createSessionFormatCatalog(v4SessionFormatCatalogOptions)

/**
 * V4-target catalog whose V3→V4 edge knows one parent's historical children.
 * @param children - complete child evidence retained unchanged for the catalog's lifetime.
 * @returns a V4-target catalog with independent restore state per artifact.
 */
export function createV4SessionFormatCatalogWithChildren(
  children: readonly SessionFormatJsonValue[],
): SessionFormatCatalog {
  const migration = createSessionFormatV3ToV4(children)
  return createSessionFormatCatalog({
    ...v4SessionFormatCatalogOptions,
    migrations: v4SessionFormatCatalogOptions.migrations.map(edge => edge === sessionFormatV3ToV4 ? migration : edge),
  })
}

/**
 * Adopt one released V4 artifact through the installed current reader.
 *
 * The V4 physical rows are re-read by the current catalog, which runs the V4→V5
 * edge, so `Session.fromRestore` validates current logical records while the
 * test keeps asserting the released V4 representation.
 * @param artifact - complete validated V4 artifact.
 * @returns the same logical history restored as the current V5 generation.
 */
export function restoreV4AsCurrent(artifact: SessionFormatArtifact): SessionFormatArtifact {
  const physical = releasedV4SessionFormatCodec.encodeHeader(artifact.header, artifact.inheritedEventCount)
  const reader = currentFormatCatalog.createRestore(physical, { recovery: 'strict', validation: 'current' })
  for (const event of artifact.events) reader.decodeRow(releasedV4SessionFormatCodec.encodeEvent(event))
  return reader.finish()
}
