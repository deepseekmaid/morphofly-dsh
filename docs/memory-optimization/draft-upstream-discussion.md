# Draft: upstream discussion post (not published)

Status: draft only — post after explicit approval.Target: https://github.com/deepseek-ai/deepseek-harness/discussions (new discussion) Related: #4722, #11689

---

## Title (EN)

`assistant/message.stream` holds 49% of session bytes and duplicates `message.content` 3× — measurements on 19 real sessions

## Title (ZH)

`assistant/message.stream` 占会话数据 49%，同一段模型输出存了 3 份 —— 19 个真实会话的实测

## Body (EN)

Field data from a 3.7 GB Windows host running dsh 0.2.2-rc.1, continuing the measurements in #4722 and #11689.

**Sample:** 19 real sessions under `~/.dsh/sessions`, 17.0 MB zstd → 59.4 MB JSONL, 15,082 events.

### What the bytes are

| event type | events | JSONL bytes | share |
|---|---:|---:|---:|
| `assistant/message` | 1,836 | 39.13 MB | **65.8%** |
| `tool/result` | 2,685 | 10.61 MB | 17.8% |
| `tool/call` | 2,671 | 2.52 MB | 4.2% |
| `user/message` | 280 | 2.25 MB | 3.8% |

Inside `assistant/message`: `stream` is 29.28 MB, `message` is 9.43 MB — the embedded stream is **3.10×** the model-facing message.

### Inside `stream`

| component | bytes | share of stream | note |
|---|---:|---:|---|
| `texts` (streamed fragments) | 9.68 MB | 33.1% | 5,454,582 chars, **100.0% identical** to message text |
| `block-end.block` (full block) | 8.07 MB | 27.6% | 5,454,364 chars, **a second 100% copy** |
| `dt` (per-chunk timing) | 4.39 MB | 15.0% | 2,057,325 numbers, pure timing markers |
| tool-call arguments | 4.01 MB | 13.7% | duplicated by `tool/call` events |
| `finish` / `replayState` | 1.25 MB | 4.3% | signatures and replay state |
| `block-start` | 0.45 MB | 1.6% | structural marker |
| `usage` | 0.31 MB | 1.0% | duplicated by the standalone `usage?` field |
| JSON key names (approx.) | 1.58 MB | 5.4% | the same keys repeated per record |

The same model output is stored **three times** (stream `texts`, stream `block-end.block`, `message.content`), and another ~19% of the stream is timing/structure that `deriveMessages()` never reads (`surface.ts:667`).

### Cost

Dropping `stream` from the resident log would cut session data **49.3%** (59.4 MB → 30.1 MB). The sidecar design in #4722 (方案 A) keeps timing on disk and loads it on demand, so this is not a lossy change.

### Why this is not a one-line fix

`stream` is still read on several paths when `data.usage` is absent: token-meter (`usage-projection.ts:85`, `turn-usage.ts:233`), headless JSON output, session-stats first-token latency, `assembleAssistantStream` measurement, subagent output text, log export, and the isolated generation verifier (`generation.ts:560`). Any format change must serve those on demand.

**Question:** is a V5 sidecar (`streams/<seq>.jsonl.zst` + `streamRef`) acceptable as the direction, or would maintainers prefer a byte-bounded resident window (方案 B) that leaves the format untouched?
