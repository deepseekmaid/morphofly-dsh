---
kind: upgrade-guide
description: "以 Session 格式 V5 写入的会话拒绝旧构建打开，并把 Assistant 流保存到旁挂目录。"
---

# Session 格式 V5 将 Assistant 流移入旁挂目录

[English](guide.md) | 中文

## 变更

写入器将 `SESSION_FORMAT_VERSION` 从 4 推进到 5，新建或更新的会话发布 `session.v5.jsonl[.zstd]` 世代。`assistant/message` 与 `assistant/attempt` 不再内嵌 `stream`；精确的流记录按结算序号移到会话目录下每个结算一个 `streams.v1/s<seq>.jsonl[.zstd]` 文件。`assistant/message` 保留可选 `usage` 并新增可选 `firstTokenTime`；`assistant/attempt` 新增可选 `usage` 与可选 `firstTokenTime`，因此重试与首字延迟统计保持当前数值。会话日志与历史消费方不再收到内嵌流，须通过 `SessionHandle.readAssistantStream(seq)` 按需读取。

旧构建会方向性拒绝 V5 日志，而不是解释它；因此在新构建写入之后，早于 V5 的宿主或 SDK 无法打开、追加或降级该会话。旁挂目录属于会话数据而非临时文件：导出、fork、备份与恢复都必须带上 `streams.v1/`，任何人不得手工编辑、改名或删除其中的文件。

读取已存储的 V4 会话只在内存中生成 V5 视图，不写盘；第一次以写方式打开才发布 V5 世代及其旁挂。没有任何批量迁移。由于 V4 世代原地保留，迁移后的会话占用约等于单个世代的 2.5 倍（V4 世代、V5 主日志与旁挂三者之和），且该开销持续增长。

## 迁移

1. 停止当前构建并备份会话目录：`cp -a ~/.dsh/sessions ~/.dsh/sessions.v4-backup`。升级前确认副本存在。
2. 安装声明 Session 格式 5 的构建，并对这些会话持续使用它。不要再用旧构建打开，旧构建会拒绝 V5 日志。
3. 打开需要继续的会话并追加一条消息。仅读取不写盘；追加会在保留的 V4 世代旁发布 `session.v5.jsonl[.zstd]` 与 `streams.v1/`。不存在迁移命令，不要对目录运行脚本。
4. 用 `du -sh ~/.dsh/sessions` 对照 2.5 倍估算检查可用磁盘。在第一次以写方式打开前补充空间或归档整个会话；绝不删除会话目录的局部内容。
5. 确认迁移：`find ~/.dsh/sessions -path '*streams.v1*' -name 's*.jsonl*'` 为每个结算列出一个旁挂文件，且每个文件名中的序号对应 V5 日志中的一个结算事件。确认旧构建以格式版本错误拒绝该日志。
6. 回滚时停止新构建，用第 1 步的备份恢复会话目录，再让旧构建针对该备份启动。备份之后新建的会话不包含在该备份中。
