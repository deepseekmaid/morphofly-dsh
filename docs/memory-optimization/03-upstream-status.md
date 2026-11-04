# 上游处理状态核查

> 核查时间：2026-11-04 ｜ 代码基线：`master @ fcc0ad46`（dsh 0.2.2-rc.1，2026-11-04 发布） ｜ 上游仓库：`deepseek-ai/deepseek-harness`（**issues 功能已关闭，只有 discussions**）

## 结论

**未处理，也未公开回应。** 核心代码锚点一处未动，所有相关 discussion 仍 open，评论区没有
任何官方成员（MEMBER / OWNER / COLLABORATOR）回复。

## 代码锚点（在最新的 0.2.2-rc.1 上逐条核对）

| 待检查项 | 现状 | 位置 |
|---|---|---|
| 会话格式是否升到 V5（stream 旁挂） | 否，仍是 V4，`assistant/message` 内嵌 `stream` | `packages/core/session/src/types.ts:90,354` |
| 常驻日志是否有上限/淘汰 | 否，仍是只 `push` 的数组 | `packages/core/session/src/index.ts:526` |
| 模型历史重建是否读取 stream | 否，只读 `message` | `packages/core/session/src/surface.ts:667` |
| 常驻会话是否有空闲卸载 | 否，注释明写常驻 | `packages/api/session-controller/src/client/sessions/session.ts:1` |
| 完整性校验是否依赖 stream | 是，但只在隔离校验路径 | `packages/session/session-persistence-jsonl/src/generation.ts:545,554` |

## Discussion 状态

| 编号 | 标题 | 状态 | 官方回复 |
|---|---|---|---|
| [#4722](https://github.com/deepseek-ai/deepseek-harness/discussions/4722) | In-memory session log is unbounded… | open（8-27 开，7 条评论） | 0 |
| [#4678](https://github.com/deepseek-ai/deepseek-harness/discussions/4678) | session.history: elide chunks of closed messages | open | 0 |
| [#10837](https://github.com/deepseek-ai/deepseek-harness/discussions/10837) | 34.59 GB app-group memory（桌面端现场报告） | open | 0 |
| [#11608](https://github.com/deepseek-ai/deepseek-harness/discussions/11608) | 投影缓存启动加载 969 条 / 209 MB | open | 0 |
| [#11689](https://github.com/deepseek-ai/deepseek-harness/discussions/11689) | 3.6 GiB 小主机内存形态 | open | 0 |

另外新开的一批同类问题也全部 open：`#7414`（会话永不卸载）、`#9925`（堆涨到 8 GB）、`#10152`（append-only 无法删历史）、`#12021`（空闲会话不释放堆）、`#11888`、`#12149`（2026-11-04）。

## 发布说明

- `v0.2.2-rc.1`（2026-11-04）与 `v0.2.2-alpha.3`（2026-11-03）里唯一相关的一条：
  「减少会话状态更新时的重复发布和目录处理开销，并降低长回复流式组装的运行时成本」
  —— 是 CPU / 延迟优化，**不涉及常驻内存根因**。
- 2026-10-30 之后没有任何提交触碰会话格式、`Session.log`、会话常驻逻辑。

## 可复现命令

```powershell
# 仓库同步状态（fork vs 上游）
gh api repos/deepseek-ai/deepseek-harness/compare/wings1848:master...master --jq '{status,ahead_by,behind_by}'

# 讨论状态
gh api repos/deepseek-ai/deepseek-harness/discussions/4722 --jq '{number,state,comments,updated_at}'

# 评论者身份（是否有 MEMBER/COLLABORATOR）
gh api graphql -f query='query { repository(owner:"deepseek-ai", name:"deepseek-harness") {
  discussion(number:4722) { comments(first:50) { nodes { author { login } authorAssociation } } } } }'

# 代码锚点
Select-String -Path packages/core/session/src/types.ts -Pattern "SESSION_FORMAT_VERSION = |stream: AssistantStreamRecord"
```
