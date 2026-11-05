---
description: "Complete V4-to-V5 Session conversion and native admission: Assistant streams leave the event log, settlement scalars stay, and the sidecar is owned by persistence."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-format-v4-to-v5

English | [中文](README.zh.md)

## Summary

Restore supported released V4 Sessions as V5 without rewriting their stored generation. The conversion removes the embedded Assistant stream from both settlement events, keeps the message payload byte-identical, and derives the two scalars synchronous consumers fold. Persistence owns the `streams.v1/` sidecar files and the successor publication; this library owns conversion and target rules. It never reads or writes sidecar files.

## Table of Contents

- [Use this package](#use-this-package)
- [V4-to-V5 specification](#v4-to-v5-specification)
  - [Header and physical framing](#header-and-framing)
  - [Assistant message conversion](#assistant-message)
  - [Assistant attempt conversion](#assistant-attempt)
  - [Preserved coordinates and timing](#preserved-coordinates)
  - [Source audit and refusal](#source-audit)
- [Native V5 admission](#native-v5-admission)
  - [Header and settlement payloads](#native-fields)
  - [Validation entry points and recovery](#native-recovery)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Use the [catalog](../session-format-catalog/README.md) for complete restoration. Direct imports serve catalog assembly and tests; this library has no Cordis mount configuration. Its [public exports](src/index.ts) provide the adjacent migration, the released V4 source codec, the V5 codec, target validators, and the V5 artifact restorer. The source codec remains owned by [V3-to-V4](../session-format-v3-to-v4/README.md).

Header-only migration advances metadata without reading the body:

```text
const targetHeader = sessionFormatV4ToV5.migrateHeader(sourceHeader)
```

Body conversion is a stateless per-artifact stage; every sequence keeps its number because the edge neither inserts nor removes events:

```text
const stage = sessionFormatV4ToV5.createStage({
  sourceHeader, targetHeader, sourceInheritedEventCount, sourceKind: 'decoded',
})
for (const event of sourceEvents) stage.transformEvent(event, context)
const targetInheritedEventCount = stage.finish(context)
```

<a id="v4-to-v5-specification"></a>
## V4-to-V5 specification

<a id="header-and-framing"></a>
### Header and physical framing

The header converts only `version` from 4 to 5. Every other metadata field keeps its value and type: `id`, `createdAt`, `cwd`, `parentSession`, `isSeeded`, `origin`, `delegationDepth`, and `agentPreset`. The physical JSONL framing is unchanged; the V5 codec reuses the released V4 row framing and stamps the writer version, so no physical re-encoding rule changes.

<a id="assistant-message"></a>
### Assistant message conversion

Source payload fields: `turn`, `step`, `message`, `stream`, `usage`, `interrupted`.

| Target field | Rule |
|---|---|
| `turn`, `step` | Required in the source, copied unchanged. |
| `message` | Required in the source, copied unchanged and byte-identical; it is the model-visible history. |
| `usage` | Copied unchanged when present; absent stays absent. |
| `interrupted` | Copied unchanged when present; absent stays absent. |
| `firstTokenTime` | Derived from the removed stream with `assistantStreamFirstTokenTime`; absent when the stream carried no token. |
| `stream` | Removed. Persistence stores the same records under `streams.v1/` when it migrates a stored generation. |

<a id="assistant-attempt"></a>
### Assistant attempt conversion

Source payload fields: `turn`, `step`, `stream`.

| Target field | Rule |
|---|---|
| `turn`, `step` | Required in the source, copied unchanged. |
| `usage` | Taken from the last `usage` chunk of the removed stream; absent when the stream reported none. |
| `firstTokenTime` | Derived from the removed stream with `assistantStreamFirstTokenTime`; absent when the stream carried no token. |
| `stream` | Removed. |

An attempt keeps `usage` and `firstTokenTime` because the synchronous statistics fold previously read both from the embedded stream; dropping either would change reported token and latency values for retried or failed steps.

<a id="preserved-coordinates"></a>
### Preserved coordinates and timing

Every event keeps its type string, `seq`, `time`, envelope `surfaceOp`, and `ignorable` marker. Every event that is not one of the two settlements is emitted as the same object, byte-for-byte. The inherited cut is a logical event count; the edge preserves it, deriving it from the last inherited `session/end-seed` marker when the decoder could not supply it before EOF and refusing a supplied cut that disagrees with that marker.

<a id="source-audit"></a>
### Source audit and refusal

The edge refuses, without publishing a partial successor, when:

- a settlement payload is not a JSON object;
- a settlement payload carries a field outside the released source allowlist (unknown fields could acquire new target meanings);
- `turn`, `step`, or `message` is missing from an Assistant message settlement;
- the source has no `stream` array;
- the stream fails `expandAssistantStream` record admission;
- an unseeded Session contains an inherited `session/end-seed` marker;
- a seeded Session reaches EOF without its inherited marker;
- the supplied inherited cut disagrees with the derived marker cut.

Plugin records in the `plugin:` namespace and unknown ignorable events are carried forward unchanged; the edge does not interpret opaque payloads.

<a id="native-v5-admission"></a>
## Native V5 admission

<a id="native-fields"></a>
### Header and settlement payloads

The header keeps the exact V4 field set with `version` fixed at 5. A settlement payload is admitted only when:

| Type | Admitted fields | Required scalar checks |
|---|---|---|
| `assistant/message` | `turn`, `step`, `message`, `usage`, `interrupted`, `firstTokenTime` | `firstTokenTime`, when present, is a non-negative safe integer. |
| `assistant/attempt` | `turn`, `step`, `usage`, `firstTokenTime` | `firstTokenTime` as above; `usage.inputTokens` and `usage.outputTokens` are non-negative safe integers. |

Any other field, including a residual `stream`, is rejected. All non-settlement events inherit the released V4 admission through the V4 restorer; the V5 checks add only the settlement rules above.

<a id="native-recovery"></a>
### Validation entry points and recovery

`assertReleasedV5Header` validates header metadata, `assertReleasedV5Settlement` validates one settlement payload, and `restoreReleasedV5Artifact` validates a complete artifact: released V4 restoration runs first, then every known-type V5 settlement is admitted. `releasedV5SessionFormatCodec` provides decode and encode over the V5 header and rows, reusing the released V4 physical framing. Persistence selects the recovery policy; the artifact restorer applies strict validation and never falls back to a predecessor generation.

<a id="understand-the-implementation"></a>
## Understand the implementation

`src/migration.ts` holds the adjacent declaration and the per-artifact stage. `src/validation.ts` holds the target header, settlement, and artifact admission. `src/codec.ts` holds the physical codec, which maps the V5 header version onto the released V4 decoder and encoder.

<a id="further-exploration"></a>
## Further Exploration

- [Session format versions and release status](../../../docs/session-format-status.md) — writer and release authority.
- [Historical format references](../../../docs/persistence-changes/historical-formats/README.md) — the archived V4 schema this edge converts.
- [Session persistence JSONL backend](../session-persistence-jsonl/README.md) — owns `streams.v1/` sidecars and successor publication.

<a id="model-experience"></a>
## Model Experience

### Historical restoration

#### What the model sees

Historical requests retain their recorded messages and model configuration. The [migration stage](src/migration.ts) removes only the timed stream and recomputes its two scalar summaries, so every message block a model saw is reconstructed unchanged.

#### Token effect

The conversion changes no request text or token-bearing data. `usage` is copied from the released settlement, and a stream-derived `usage` fallback fills an attempt that reported none.

#### KV Cache effect

The edge preserves the recorded request prefix exactly; provider cache availability and eviction remain outside this library.

## Known Limitations and Deferred Work

- The edge returns logical events only; it neither reads nor writes sidecar files.
- A caller that converts a stored V4 generation without a persistence layer that tees the removed streams loses the timed stream for that generation; persistence owns that guarantee.
- Fork paths must copy `streams.v1/` from the source Session directory; export archives already package it.

### Dev Note

None.
