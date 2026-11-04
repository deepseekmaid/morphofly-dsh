# dsh 内存优化工作区

本目录是 `wings1848/morphofly-dsh`（`deepseek-ai/deepseek-harness` 的 fork）里关于`dsh web` 内存占用问题的复核与方案设计工作区。

## 文档索引

| 文件 | 内容 | 状态 |
|---|---|---|
| [02-solution-plan.md](02-solution-plan.md) | **决策建议**：方案对比、分阶段路线、验收标准、待拍板问题 | 待审核 |
| [01-root-cause.md](01-root-cause.md) | 根因复核：本机 19 个真实会话的实测数据 + issue #1 断言逐条核对 | 已完成 |
| [03-upstream-status.md](03-upstream-status.md) | 官方（上游）处理状态：discussion 状态、代码锚点、发布说明 | 已完成 |
| [drafts/format-v5.md](drafts/format-v5.md) | V5 stream 旁挂的完整工程设计（数据布局/类型/一致性/迁移/测试） | 调研完成 |
| [drafts/consumers-and-retention.md](drafts/consumers-and-retention.md) | stream 消费方审计（11 处）+ 方案 B/C 可行性 | 调研完成 |
| [drafts/migration-conventions.md](drafts/migration-conventions.md) | 上游格式演进规范：V5 必做 14 项 + 可复用机制评估 | 调研完成 |
| [draft-upstream-discussion.md](draft-upstream-discussion.md) | 准备发到上游 discussion 的草稿（**未发布**） | 待用户审核 |

## 工具

`tools/` 下是只读分析脚本，用于复现 `01-root-cause.md` 里的数字：

```powershell
cd docs\memory-optimization\tools
node analyze-sessions.mjs     # 事件类型占比、会话总量
node stream-breakdown.mjs     # assistant/message.stream 字段组成拆解
```

脚本读取 `~/.dsh/sessions`，不修改任何会话文件。

## 关键结论（摘要）

- 本机实测：`assistant/message` 占会话数据 65.8%；其 `stream` 字段占会话数据 49.3%，
  是 `message` 的 3.1 倍；同一段模型输出在日志里存 3 份（100% 重复）。
- 上游截至 0.2.2-rc.1（2026-11-04）未修复：格式仍是 V4 内嵌 stream，日志无上限，会话常驻；
  相关 discussion 全部 open 且无官方回复。
- 彻底修复必须动核心会话层（格式 + 内存所有权），插件层只能缓解。

## 注意

本目录是工作文档，未纳入上游 `website/` 文档体系；如要向上游提交，需按`docs/cookbook/adding-a-session-format-version.md` 与 `docs/session-format-status.md`的规范重新组织。
