---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-06-session-format-v5

English | [中文](2026-11-06-session-format-v5.zh.md)

## Summary

Advances the declared SessionHeader.version from 4 to 5: both Assistant settlement events remove the required embedded `stream` and add optional `firstTokenTime`, `assistant/attempt` also gains optional `usage`, and the removed streams move to Session-local `streams.v1/` sidecar files.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-06-session-format-v5
baseline: false
changes:
  - root: "SessionHeader"
    previous: "2026-09-16-session-format-v4"
    after: "22c6899a78214dd841c266348ae997027ef391174ddb21127f1b71dc1b362824"
    decision: version-bump
  - root: "event:assistant/attempt"
    previous: "2026-09-16-session-format-v4"
    after: "eb2e8ef1a8e29feab9c67af239ff11fbfcb0fa4447cb6947447f4f8df93bf8c3"
    decision: version-bump
  - root: "event:assistant/message"
    previous: "2026-09-16-session-format-v4"
    after: "11ba43079605f7723b9ad4f2e94251f2d0a55adcf0e22687aa234f17cc977e1f"
    decision: version-bump
```

<a id="compatibility"></a>
## Compatibility

Persistence publishes V5 as a new generation beside the unchanged V4 files, so an existing V4 Session keeps its bytes and paths; a read open migrates a supported V4 generation in memory and a write open publishes the V5 successor plus one sidecar per removed stream. V5 readers therefore preserve historical meaning, while V4 readers refuse a V5 log as a newer format instead of misinterpreting the removed fields; there is no downgrade or fallback. The loop moves each settlement stream out of the event on a non-durable `Session.appendWithCarry` carrier that the persistence writer claims with `takeAssistantStream` during the synchronous event dispatch; the carrier never enters the log. Synchronous consumers read the recorded `firstTokenTime` and `usage` scalars, and the exact timed stream is available through the optional `SessionHandle.readAssistantStream` capability, whose V4-generation handles fall back to the embedded row. A settlement whose sidecar is missing or unreadable is refused loudly, and exports, forks, and backups must carry the `streams.v1/` directory. The [V4-to-V5 migration](../../packages/session/session-format-v4-to-v5/README.md) owns conversion and native V5 admission.

<a id="verification"></a>
## Verification

`vitest run packages/session/session-format-v4-to-v5/tests packages/session/session-persistence-jsonl/tests/streams.spec.ts packages/session/session-persistence-jsonl/tests/stream-sidecar.spec.ts` passed 63 tests across 5 files. `tsx scripts/persistence-changes.ts --check` reports the recorded history matching the current V5 inventory.

<a id="dev-note"></a>
## Dev Note

None.
