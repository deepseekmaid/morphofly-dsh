---
kind: upgrade-guide
description: "Sessions written in Session format V5 refuse older builds and keep Assistant streams in a sidecar directory."
---

# Session format V5 moves Assistant streams into a sidecar

English | [中文](guide.zh.md)

## Change

The writer advances `SESSION_FORMAT_VERSION` from 4 to 5, and new or updated Sessions publish a `session.v5.jsonl[.zstd]` generation. `assistant/message` and `assistant/attempt` no longer carry the inline `stream`; the exact timed stream moves to one `streams.v1/s<seq>.jsonl[.zstd]` file per settlement sequence in the Session directory. `assistant/message` keeps optional `usage` and adds optional `firstTokenTime`; `assistant/attempt` adds optional `usage` and optional `firstTokenTime`, so retry and first-token statistics keep their current values. Session log and history consumers receive no inline stream and must read it on demand through `SessionHandle.readAssistantStream(seq)`.

An older build refuses a V5 log instead of interpreting it, so a host or SDK that predates V5 cannot open, append to, or downgrade a Session after a newer build writes it. The sidecar directory is Session data, not scratch: exports, forks, backups, and restoration must carry `streams.v1/`, and nobody may edit, rename, or delete those files by hand.

Reading a stored V4 Session produces an in-memory V5 view without writing; the first write open publishes the V5 generation and its sidecar. Nothing migrates Sessions in bulk. Because the V4 generation stays in place, a migrated Session occupies roughly 2.5 times one generation, combining the V4 generation, the V5 main log, and the sidecar, and that cost keeps growing.

## Migration

1. Stop the current build and back up the Sessions directory: `cp -a ~/.dsh/sessions ~/.dsh/sessions.v4-backup`. Confirm the copy exists before upgrading.
2. Install the build that declares Session format 5 and keep it for these Sessions. Do not open them again with an older build, which refuses V5 logs.
3. Open each Session that must continue and append one message. Reading alone writes nothing; the append publishes `session.v5.jsonl[.zstd]` and `streams.v1/` next to the retained V4 generation. No migration command exists, so do not run scripts against the directory.
4. Compare available disk space with `du -sh ~/.dsh/sessions` against the 2.5 times estimate. Add space or archive whole Sessions before the first write open; never delete parts of a Session directory.
5. Confirm the migration: `find ~/.dsh/sessions -path '*streams.v1*' -name 's*.jsonl*'` lists one sidecar per settlement, and each filename's sequence names a settlement event in the V5 log. Confirm an older build refuses the log with its format-version error.
6. To roll back, stop the new build, restore the Sessions directory from the step 1 backup, and start the older build against the backup. Sessions created after the backup are not part of it.
