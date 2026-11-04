# 迁移约定：一个能被上游接受的 stream 旁挂改动长什么样

> 基线 `morphofly-dsh @ fcc0ad46`（dsh 0.2.2-rc.1）。只回答「V5 要做什么、有什么可复用」，不含实现方案。文中 `path:line` 均可在本 checkout 复核。

## 一、结论（先看这 6 条）

1. 上游的门槛不是「schema 变了就升版本」，而是**读者兼容性**：同版本可以改，只要老读者能安全恢复、安全忽略，或在执行/改写/截断前明确拒绝（`docs/session-format-status.md:35`、`docs/persistence-changes/README.md:51`）。
2. `stream` 是 `assistant/message` / `assistant/attempt` 的**必填** body 字段，且恢复期校验强制要求是数组（`packages/core/session/src/types.ts:349-357,363`；`packages/core/session/src/index.ts:284-296`）。在 V4 里删掉或搬走它，0.2.2-rc.1 的老读者抛的是「invalid settlement fields」这类通用校验错，**不是方向性拒绝** → 不满足同版本安全要求。
3. 同版本能做到的只是「追加」，不是「搬走」；而只要 stream 还原地留着，字节一分不省。所以**省字节这件事天然指向升版本**。
4. 现成机制里没有一个同时满足「持久 + 按会话 + 可校验 + 可迁移」：最贴合的是**会话自有目录下的伴生文件**（沿用现有不可变代际、无覆盖发布、写时租约），但要补 persistence seam、验证、上传/导出、Web 读取四块。
5. 上游对「升版本」不陌生，但很贵：V4 定稿后 40 天里 **13 条同版本记录、0 次再升版本**；V5 会是第一个「已发布格式再升版本」的案例（无干净先例）。
6. 判据落点：**V5 + 懒迁移**（历史 V4 一字不动，只有新写的结算消息走旁挂）比「在 V4 里做安全 reader 变更」更可能被接受，也更干净。

## 二、V5 必做清单（14 项）

| # | 必做项 | 证据 |
|---|---|---|
| 1 | `SESSION_FORMAT_VERSION = 5`（唯一手写的写入方权威） | `packages/core/session/src/types.ts:90` |
| 2 | 新边包 `packages/session/session-format-v4-to-v5/`，声明 `dsh.sessionFormatMigration{from:4,to:5,export,migration,sourceCodec,targetCodec,targetHeaderValidator,targetRestorer}` | `packages/session/session-format-v3-to-v4/package.json:29-40` |
| 3 | 复用上一条边导出的 V4 codec，不复制、不重定义 | `session-format-v3-to-v4/src/index.ts:3` |
| 4 | catalog 增加该边依赖并重新生成 `generated.ts`（禁手改） | `packages/session/session-format-catalog/src/generated.ts:1-3`；命令 `pnpm run gen-session-format-catalog` |
| 5 | `tsconfig.base.json` paths + 包内 `references` 接入 | `tsconfig.base.json:521-526`、`session-format-v3-to-v4/tsconfig.json` |
| 6 | 更新所有 current-version 消费者：JSONL 文件名选择与发布、catalog 的 encoder/restorer、投影缓存 `formatVersion` 身份、replay/snapshot 归一化、fixture 布局校验、TS 与 Python SDK 预期 | `docs/cookbook/adding-a-session-format-version.md:76` |
| 7 | 归档出站格式：`pnpm run verify-persistence-formats --archive 4` + `docs/persistence-changes/historical-formats/v4.{md,zh.md,i18n.yaml,schema.json}` | `historical-formats/README.md:48-60` |
| 8 | 类型变更记录四件套（en/zh/i18n.yaml/schema.json），`decision: version-bump`，且必须带自己的 header 版本迁移 | `docs/persistence-changes/README.md:33-44,63` |
| 9 | 定稿检查点 `docs/persistence-changes/finalized/v5.json` + `latestFinalizedVersion: 5` | `persistence-changes/README.md:44` |
| 10 | 快照继承：受影响 owner 新增 `session.v5.jsonl`，所有前代字节不变、父子角色连续 | `adding-a-session-format-version.md:85-96`、`docs/testing.md:14` |
| 11 | 新边 README 作为**唯一完整**的变换/准入目录（en/zh/i18n.yaml），逐条列出转换、保留、拒绝策略 | `adding-a-session-format-version.md:69` |
| 12 | 双语同步：`session-format-status.*`、cookbook、`docs/subsystems/*`、historical-formats 各页一起改 | `docs/AGENTS.md` i18n 规则 |
| 13 | 外部可感知的破坏性改动立刻写 upgrade guide（`docs/upgrade-guide/<version>/`） | `AGENTS.md`；`.agents/skills/dsh-create-upgrade-guide/SKILL.md` |
| 14 | 更新 owning Agent Note（不新增重复决策记录），归档相关旧 note | `adding-a-session-format-version.md:111` |

**Review 门（6 个可执行）**：`pnpm run verify-session-format-catalog`；`pnpm exec vitest run scripts/gen-session-format-catalog.spec.ts packages/session/session-format/tests packages/session/session-format-catalog/tests` + 新边 tests；`pnpm run verify-persistence-changes` / `verify-persistence-catalog` / `verify-persistence-formats`；`pnpm run test:snapshot`（语料策略不变）；`pnpm run verify-translation-pairing --write <改动对>` + `pnpm run test:docs` + `pnpm run doc-sync` + `pnpm run lint`；`git diff --check`。`scripts/doc-standard.spec.ts` 另会校验状态记录结构、双语一致、证据 tag 与 writer 顺序（`session-format-status.md:56`），发布记录**只在发布后**才前进（`:54`）。

## 三、相邻迁移包的最小骨架

```
packages/session/session-format-v4-to-v5/
  package.json          # name/exports/files + dsh.sessionFormatMigration + deps(session-format, 前一条边)
  tsconfig.json         # extends tsconfig.base.json, rootDir src, outDir lib/types, references
  tsdown.config.ts      # 与相邻边逐字相同（entry lib/types/index.js）
  src/index.ts          # 再导出前一代 codec + 本边 codec/migration/validation
  src/codec.ts          # target codec（releasedV5SessionFormatCodec）
  src/migration.ts      # defineSessionFormatMigration(...) + createStage
  src/validation.ts     # assertReleasedV5Header / restoreReleasedV5Artifact
  tests/*.spec.ts       # 边变换、拒绝、字节保持、确定性、并发 stage 隔离
  README.md/.zh.md/.i18n.yaml
```

接入点只有 3 处：catalog 的 `package.json` 依赖、`tsconfig.base.json` 的 paths、生成器产出的 `generated.ts`；工作区靠 `pnpm-workspace.yaml:2` 的 `packages/*/*` 自动纳入。

**两个容易踩的硬约束**：
- Stage 只有 `emitEvent/emitRun`，没有文件 I/O（`packages/session/session-format/src/types.ts:134-157`）。所以**迁移边写不出旁挂文件**——旁挂的写入/读取属于 persistence 层，历史 V4 只能原样保留内嵌 stream（这正是懒迁移的技术理由）。
- catalog 是 build-static、与插件挂载无关（`adding-a-session-format-version.md:48`），新边必须在 catalog 中静态可达，不能靠运行时注册。

## 四、可复用机制评估

| 机制 | 存储位置 / 语义 | 能否承载 stream 旁挂 | 关键约束 |
|---|---|---|---|
| `packages/spill` + `spill-local` | `<root>/session-<hash>/<random>-<name>`，0700，默认 OS 临时目录，启动时按 30 天清扫 | ✗ | 不保证持久（`spill-local/README.md:44,59`）、无校验、定位符只对同机消费者有意义（`:126-127`）；语义是工具输出外溢 |
| `packages/attachment` + `attachment-local` | `<DSH_HOME>/attachments/v1/objects/<sha256>` 内容寻址、去重、fsync 链、硬链接发布、读时校验、永不自删（`:55,84,92`） | △ 只借做法 | 语义是用户附件 + 模型可见句柄；无会话归属/代际；GC 明确推迟 |
| `packages/storage`（json/sqlite）+ `storage-domain` | `dshHomePath('storages')` 下的 KV 文档，整条记录写、`compatibleVersions`、backup-and-skip | △ 仅适合小指针 | 整文件重写（29 MB 级不可）；无淘汰；唯一真实旁挂先例是 `session_projcache`（`session-projection-cache/README.md:38,65`） |
| `session-projection-cache` | 派生折叠检查点，按 `formatVersion/createdAt/cwd/isSeeded` 身份匹配 | ✗ | 契约是「日志权威、缓存跟随」（`:12,65`），缓存可丢；放权威数据会反转权威性 |
| `PluginRecordMap` / `appendPluginRecord` | 写进日志的 `plugin:` 忽略事件（`packages/core/session/src/types.ts:540-548`） | ✗（可当指针候选） | 占日志字节；跨版本迁移只「尽力保留、可丢弃」（`adding-a-session-format-version.md:61`）→ 指针会丢 |
| 会话自有目录新增伴生文件 | `<root>/--<cwd>--/<id>/` 已有多个不可变 `session.vN.jsonl[.zstd]` 代际（`session-persistence-jsonl/README.md:59-73`） | ✓ 最贴合 | 沿用无覆盖发布、写租约、代际约定；需补：seam 目前每会话只有一个 artifact（`session-persistence/src/errors.ts:85-88`）、Worker 验证只验日志字节、`dsh_session_log` 上传与导出要带/排除、Web 客户端只能经 BFF 读 |

补充事实：仓库**没有会话删除/淘汰机制**（persistence seam 无 delete；投影缓存也明确把清理留作 out-of-band，`session-projection-cache/README.md:127`），所以旁挂的 GC 可以沿用同一立场，不必先造 GC 再来。

## 五、上游接受度：V5 vs 在 V4 内做安全 reader 变更

| 观察 | 证据 |
|---|---|
| 同版本路径是日常：V4 升版本记录（2026-09-16）之后 13 条记录**全部** `decision: same-version`，无第二次升版本 | `docs/persistence-changes/2026-1*.md` 的 `decision:` 字段；命令见第七节 |
| 升版本是大工程：V4 边在 09-16→09-18 于 `release/*` 集成分支完成（提交 `669b724a`、`0112eaf3`），09-29 随 `dsh-v0.2.0-rc.2` 发布；cookbook 要求先 `release/*` 基线再拆子分支 | `adding-a-session-format-version.md:27`；`gh api repos/deepseek-ai/deepseek-harness/commits?path=...` |
| 历史升版本都发生在密集 alpha 期（V2 08-31、V3 09-06；首个 release 08-17），**没有已发布稳定格式再升版本的先例** | 提交日期来自上方 commits API；releases 列表最早 2026-08-17 |
| 同版本「搬走 stream」会静默误读：`stream` 空数组能过验证但跳过内容一致性校验（`generation.ts:565`），下游统计/子代理输出退化为空 | `packages/session/session-persistence-jsonl/src/generation.ts:554-576`、`packages/session/session-stats/src/projection.ts:135`、`packages/subagent/subagent/src/assistant-output.ts:38` |
| 远端消费者只认版本号：上传字段自带 `sessionFormatVersion`，且「provider metadata stays in the embedded stream」 | `packages/session/session-log-deepseek/README.md:41` |

**判断**：走 V5 更容易被接受——方向性拒绝（“written by a newer harness”）是免费拿到的，远端能按 `sessionFormatVersion` 分辨新语义，机制也齐全；代价是要一次交付上面 14 项。同版本只适合「让 stream 变小但不搬走」的增量优化（去时序、去重复副本），且要逐消费者证明不误读——比 V5 更费论证。（待补充：本仓库 `pulls` API 返回 404，无法逐 PR 引用；现有结论基于 commit 与记录文件。）

## 六、「优雅」的判据

1. **最少新概念**：只加一个版本整数 + 一个可由 `(会话目录, 消息 seq)` 推导的伴生文件名；不新增服务、不新增配置项，指针字段可选。
2. **不破坏已发布数据**：V4 文件零字节改动；V5 reader 同时接受「历史内嵌 stream」与「新写旁挂引用」两种表示（同版本内本就是表示族，`adding-a-session-format-version.md:31`）。
3. **懒迁移**：V4→V5 边是恒等边（只为升 header），历史永远按原样读；只有第一次跨版本**写入**才发布 V5 代际（读不发布、写才发布，`adding-a-session-format-version.md:80`）。
4. **可回退**：降级读 V5 得到方向性拒绝 + 原始日志路径，不误读（`2026-08-10-session-log-version-mechanism.md:19`）；旁挂写失败时退回内嵌 stream，日志任何时刻可独立恢复。
5. **提交点纪律**：先落旁挂并 fsync，再 append 结算事件（同 attachment「先持久化后记日志」）；孤儿旁挂可回收，不允许悬空引用。

## 七、复核命令

```powershell
cd D:\Code_Project\morphofly-dsh
Select-String -Path docs\persistence-changes\2026-1*.md -Pattern "decision: (\S+)"
Get-ChildItem packages\session\session-format-v3-to-v4 -Recurse -File | Select-Object Name
gh api "repos/deepseek-ai/deepseek-harness/commits?path=packages/session/session-format-v3-to-v4&per_page=30" --jq '.[] | "\(.sha[0:8]) \(.commit.author.date[0:10]) \(.commit.message|split("\n")[0])"'
Select-String -Path packages\core\session\src\types.ts -Pattern "SESSION_FORMAT_VERSION = "
```
