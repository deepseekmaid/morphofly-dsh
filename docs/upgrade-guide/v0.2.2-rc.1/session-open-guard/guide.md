---
kind: upgrade-guide
description: "observeSession refuses a cold open when the stored log no longer fits the free heap."
---

# observeSession refuses a cold open that no longer fits the free heap

English | [中文](guide.zh.md)

## Change

`observeSession` prices a cold open before it reads the stored log. It multiplies the artifact size from `stat().sizeBytes` by `coldOpenHeapMultiplier` and compares that estimate with `coldOpenHeapShare` of the free V8 heap. An estimate that does not fit fails the read with `SESSION_QUERY_SESSION_TOO_LARGE`, and the message names the stored size, the estimate, and the free heap. The refusal happens before the log is opened, so no Session is materialized and the host keeps the heap it had.

The prepared-Session cache gains a byte bound beside its entry bound: `preparedSessionCacheBytes` limits the estimated heap retained by unpinned entries, and least-recently-used entries are evicted until the retained estimate fits.

## Migration

Nothing to migrate. A host whose Sessions fit its heap behaves as before; a host that could previously open an oversized Session and then thrash now gets a readable failure instead. The backend `Config` accepts three inherited knobs, defaulted as shown:

| Field | Default | Meaning |
|---|---|---|
| `coldOpenHeapShare` | `0.5` | Share of free V8 heap one cold open may estimate; `0` disables the guard |
| `coldOpenHeapMultiplier` | `8` | Estimated heap bytes per stored artifact byte |
| `preparedSessionCacheBytes` | `128 MiB` | Estimated heap retained by cached cold observations; a pinned entry counts but is never evicted; `0` disables the byte bound |

The guard is an estimate, not a measurement. A backend that reports no `sizeBytes` cannot be priced and passes, and an estimate below the real cost still materializes the log. Setting `coldOpenHeapShare` to `0` disables the guard, and raising the host heap remains the only way to actually load a Session whose estimate exceeds its share.
