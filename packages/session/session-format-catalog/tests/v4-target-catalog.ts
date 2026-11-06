/**
 * Released V4 catalog target for catalog tests that assert released-generation behavior.
 *
 * The first-party catalog now targets V5. These helpers retarget the same static
 * inventory at V4 with the released V4 codec and native validators, which keeps
 * tests about released V4 admission independent of the current writer.
 */

import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import {
  createSessionFormatCatalog,
  type SessionFormatCatalogOptions,
} from '@deepseek-ai/dsh-session-format'
import { assertReleasedV4Header, releasedV4SessionFormatCodec, restoreReleasedV4Artifact } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { sessionFormatCatalogOptions as currentFormatCatalogOptions } from '../src/generated.ts'

/** Current catalog options retargeted at the released V4 generation. */
export const v4SessionFormatCatalogOptions: SessionFormatCatalogOptions = {
  currentVersion: 4,
  codecs: currentFormatCatalogOptions.codecs.slice(0, 5),
  currentEncoder: releasedV4SessionFormatCodec,
  migrations: currentFormatCatalogOptions.migrations.slice(0, 4),
  restoreCurrent: artifact => restoreReleasedV4Artifact(artifact, KNOWN_SESSION_EVENT_TYPES),
  restoreTransformedCurrent: artifact => restoreReleasedV4Artifact(artifact, KNOWN_SESSION_EVENT_TYPES),
  restoreCurrentHeader(header) {
    assertReleasedV4Header(header)
    return header
  },
}

/** V4-target catalog that restores released V4 artifacts as V4. */
export const v4SessionFormatCatalog = createSessionFormatCatalog(v4SessionFormatCatalogOptions)
