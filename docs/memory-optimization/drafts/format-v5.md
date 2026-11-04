# 会话格式 V5：assistant 流旁挂（方案 A）设计草案

> 基线：`master @ fcc0ad46`（dsh 0.2.2-rc.1），`SESSION_FORMAT_VERSION = 4`（`packages/core/session/src/types.ts:90`，V4 已发布：`docs/session-format-status.md` 的 `latestReleasedVersion: 4`）。实测依据：`docs/memory-optimization/01-root-cause.md`（stream 占会话数据 49.3%，与 `message.content` 100% 重复，`deriveMessages` 不读它）。本文是工程草案，不是已实现说明；标「待定」处需实现前用一次性实验定论。

## 0. 结论

1. V5 = **从事件载荷中删掉 `stream`，把流数据落到会话目录下的旁挂文件**；主日志行不再包含时序数据，加载路径永不读旁挂。
2. 升版本是必须的：V4 读者拿不到 `stream` 会走到 `expandAssistantStream(event.data.stream)`（`packages/session/session-persistence-jsonl/src/generation.ts:560`）和全部 `event.data.stream` 消费方，属于「现有判别式无法防止不安全解释」，符合 `types.ts:78-80` 的升版本条件；旧构建读到 V5 头会在 `refuseForeignFormatVersion` 直接被拒（`.../format.ts:340-346`），不会静默错读。
3. 不引入 `streamRef` 字段：旁挂文件名由事件自己的 `seq` 唯一决定（见 §1），省掉引用校验与悬空引用，迁移也不会写错引用。

## 1. 数据布局

- 旁挂目录：`<sessionDir>/streams.v1/`。`sessionDir()` 已明确是「留给未来会话本地产物」的目录（`packages/session/session-persistence-jsonl/src/format.ts:259-269`），与 `session.vN.jsonl[.zstd]` 同层，不改动任何已发布文件。
- 旁挂文件：`streams.v1/s<seq>.<jsonl|jsonl.zstd>`，一个已结算事件一个文件（`assistant/message` 与 `assistant/attempt` 各一份，空流也写，保证「事件类型 ⇔ 旁挂应存在」可判定）。内容一行 JSON：`{"seq":N,"stream":[...]}`，`stream` 即 `AssistantStreamRecord[]`（`packages/llm/llm/src/assistant-stream.ts:20-44`）。
- 压缩跟随后端配置：后缀取 `logSuffix()`（`.../format.ts:42-48`），复用 `compressZstdFrame` / `scanZstdFrames`（`.../generation.ts:41-46`）。
- 命名安全性：`streams.v1/` 不会被代际扫描误认。`parseGenerationLogFilename` 只认 `session[.vN].jsonl`（`.../format.ts:70-77` 与 `packages/session/session-format/src/filename.ts:5-31`），目录扫描只取匹配名（`.../index.ts:1536-1572`）。
- 原子写：同目录临时文件 + fsync + 硬链接/`MoveFileExW` 发布（沿用 `writeSyncedTempFile` `.../index.ts:1361-1371` 与代际发布规则）。文件创建后**不可变**；重试时已存在的同 seq 文件按内容摘要校验后复用，不匹配则显式报错。
- 为什么不是「每会话一个 append-only 旁挂 + 索引」：按 seq 读取需要额外索引文件，等于新增第二份一致性面；按事件分文件把读取变成 O(1)，且单文件损坏不影响其它事件。
- 为什么不复用 attachment store（`packages/attachment/attachment-local/src/index.ts:180` 的 `~/.dsh/attachments/v1`）：那是全局内容寻址存储，没有会话生命周期、fork 复制与导出边界，语义不匹配。

## 2. 类型改动

- `types.ts:349-357` 改为 `'assistant/message': { turn; step; message: AssistantMessage; usage?: TokenUsage; interrupted?: true; firstTokenTime?: number }`，删除 `stream`。
- `types.ts:363` 改为 `'assistant/attempt': { turn; step; usage?: TokenUsage }`，删除 `stream` 并**补 `usage`**。理由：attempt 的唯一 usage 来源就是内嵌流的 `usage` chunk（`packages/llm/token-meter/src/turn-usage.ts:233,246`），不补字段就会丢账；结算点已有 `live.usage` 可用（`packages/core/agent-loop/src/agent.ts:505-518` 的 message 分支即同源写法）。
- `firstTokenTime`：唯一必须留在事件里的时序标量。`session-stats` 是同步纯折叠（`packages/session/session-projection/src/index.ts:103,748`），拿不到异步旁挂；首字延迟目前由 `assistantStreamFirstTokenTime(event.data.stream)` 提供（`packages/session/session-stats/src/projection.ts:135,142`），改为读该字段，写入侧从 `live.stream` 计算。单条成本 1 个数字，相对 49.3% 的节省可忽略。
- `SESSION_FORMAT_VERSION = 5`（`types.ts:90`）；同步更新生成的 catalog（`pnpm run gen-session-format-catalog`，见 `docs/cookbook/adding-a-session-format-version.md:42-48`）。
- 内存形状：`Session.log`（`packages/core/session/src/index.ts:526`）里不再有任何流数据；`SessionStore` 的常驻 `Map`（`index.ts:1065`）随之变轻。V4 日志兼容完全由相邻迁移边承担（§5），V5 读者只认 V5 事件形状。

## 3. 写入路径与一致性

- 生产方仅 4 处：`agent.ts:518`（中断的 assistant/message）、`agent.ts:581`（正常 assistant/message）、`agent.ts:523/529/546`（attempt）。它们改为**不再把 stream 放进事件**，改走载荷旁路（下述 carrier）。
- carrier 机制（避免 stream 进入 `Session.log`）：`Session.append()`（`packages/core/session/src/index.ts:806`）增加可选末参 `carry?: { assistantStream?: readonly AssistantStreamRecord[] }`，在分配 `seq` 后登记到 Session 内部的有界 `pendingStreams: Map<Seq, stream>`，随后才发布 `session/event`；新增 `Session.takeAssistantStream(seq)` 一次性认领并删除。未认领的条目在 `session/flush`/close 时丢弃（无持久化后端时流本就不该常驻）。
- 后端认领点：JSONL provider 的 `session/event` 监听（`.../storage.ts:549-553`）在 `enqueueLive` 内取走 carrier（与 `structuredClone` 同一个地方，`storage.ts:274-281`），流只存活在 ≤200ms 的写缓冲里（`LIVE_WRITE_BATCH_MAX_DELAY_MS = 200`，`storage.ts:36`）。
- 提交顺序（硬约束）：**先旁挂、后主日志行**。在 `persistContiguous`（`storage.ts:319-343`）→ `persistBatch`（`.../index.ts:911-925`）里，先按 batch 内每个 `assistant/*` 事件写并 fsync 旁挂文件，再调用 `appendLines` 追加 V5 行（`.../index.ts:1413-1443`）。
- 崩溃/失败矩阵：

| 失败点 | 结果 | 处理 |
|---|---|---|
| 旁挂写失败 | 主日志未写，`cursor` 不动 | batch 留在缓冲里重试（`storage.ts:294-316` 保留批次） |
| 旁挂写完、主日志追加失败 | 孤儿旁挂，seq 未被占用 | `rollbackAppend` 截断主日志（`.../index.ts:1443`），重试复用同 seq 文件并校验摘要 |
| 进程崩溃在两者之间 | 同上，孤儿旁挂 | 无害；下次写入同 seq 幂等复用 |
| 主日志已提交、旁挂丢失 | 只可能来自外部删改 | V5 原生会话视为数据缺失，读 API 抛类型化错误（§4）；V4 迁移来的会话可从 V4 世代回收 |
| 无持久化后端 | carrier 无人认领 | flush/close 时丢弃，不报错 |

- 旁挂与主日志的 seq 对齐：V5 事件不改变基数，`seq` 与 V4 迁移前一致；同一会话内 `seq` 唯一（`Seq` 由 `Session.append` 单点分配，`packages/core/session/src/index.ts:806`），因此文件名即主键。
- fork：`buildForkSeed` 直接复用源事件对象（`packages/core/session/src/fork.ts:21-29`），V5 下继承前缀**不带流**。fork 子会话若要能回放继承段，需在 `createStoredSession` 物化时从源会话旁挂按 seq 复制（待定：是否纳入首版；不纳入则文档写明继承段不可回放）。

## 4. 读取路径与按需 API

- 加载：`sessionLogScanner`/`catalog.createRestore` 只产事件（`.../format.ts:386-411`、`packages/session/session-format/src/types.ts:222-230`），`deriveMessages()` 走 `surface.ts:140-142` 只取 `event.data.message`（`packages/core/session/src/index.ts:999-1020`），V5 下天然不触碰旁挂。
- 新 API（放在持久化缝上，两边都能实现）：
  - `SessionPersistence.readAssistantStream(id, seq, options?): Promise<readonly AssistantStreamRecord[]>`（抽象基类 `packages/session/session-persistence/src/index.ts:144-210`）。
  - `SessionHandle.readAssistantStream(seq, options?)`（`packages/session/session-persistence/src/handle.ts:59`）。
  - 语义：文件存在 → 解压、校验内层 `seq`、返回；缺文件且事件类型要求流 → 抛 `AssistantStreamUnavailable`（可区分「本就没有」与「读坏了」）；V4 前身代际可回退扫描该世代行取出内嵌 `stream`（只读打开未发布旁挂时的兜底路径，`.../index.ts:405-419`）。
- 需要按需读的消费方（全部有 file:line，改动必须一起做）：
  - usage 兜底 3 处：`packages/llm/token-meter/src/usage-projection.ts:85`、`turn-usage.ts:233,246`、`packages/bundle/headless/src/json-stream.ts:192` → 直接改用 `event.data.usage`（V5 已补）。
  - 首字延迟 3 处：`packages/session/session-stats/src/projection.ts:135,142`、`packages/experimental/client-ui-stats/src/client/stats-fold.ts:434`、`packages/client/ui-trajectory/src/client/trajectory-assistant-definition.ts:200` → 改用 `firstTokenTime`。
  - 块重建：`packages/llm/token-meter/src/measurement-projection.ts:70` → 用 `message.content`（100% 重复即前提）。
  - 子代理文本：`packages/subagent/subagent/src/assistant-output.ts:38` → 用 message 文本。
  - 导出：`packages/session-query/session-log-export/src/archive.ts:268-280` → 附件引用改扫 `message.content`，并把 `streams.v1/` 作为独立 ZIP 条目带上（保持可还原）。
  - 校验：`generation.ts:545,554-577` 的 `assertCurrentAssistantStreams` 改为在 V4→V5 迁移边内做（那里同时握有 stream 与 message），V5 世代验证不再依赖事件内嵌流。
  - 原始日志视图/回放：`packages/experimental/session-inspector/src/client/views/session-log/model.ts:191`、`packages/api/session-controller/src/client/sessions/assistant-stream.ts:80`（后者是 live baseline，不读持久化）。前者需要新增 wire 方法（session-controller 暴露 `readAssistantStream`）；这是本方案唯一需要扩客户端协议的地方。
- 同步折叠不能等异步 I/O：所有投影单元必须保持同步（`session-projection/src/index.ts:103,748`），所以「折叠期需要的数据」只保留 `usage` 与 `firstTokenTime` 两个标量，其余全部改为按需异步读取。

## 5. 迁移策略

- **懒迁移**，复用现有机制，不新建通路：
  - 读打开（`.../index.ts:405-419`）：只把 V4 转成内存里的 V5 视图（`primed`，不写盘、不发布），流被丢弃；此时按需读走 §4 的 V4 世代回退。
  - 写打开（`.../index.ts:432-434`）：`publishStoredMigration` 发布 `session.v5.jsonl.zstd` **并写旁挂**，然后才允许 append。这就是 `dsh web` 恢复会话的路径（`packages/core/agent-loop/src/index.ts:788` 用 `'write'` 打开）。
  - 可选的全量：仿 `scripts/migrate-sessions-to-v4.ts`（`docs/cookbook/adding-a-session-format-version.md:124-134`）加 `migrate:sessions-to-v5`，用于一次性收窄历史语料内存/后续读取成本。
- 新增相邻边 `packages/session/session-format-v4-to-v5`：头只改 `version`；体 stage 按 `packages/session/session-format/src/types.ts:141-157` 的 Stage 协议实现 `transformEvent`/`transformRun`/`finish`——`assistant/message` 删 `stream`、`assistant/attempt` 删 `stream` 并补 `usage`，其余事件逐字节保留，基数不变、继承切点不变。
- 旁挂数据从哪来：**在 JSONL 后端做 tee**，不改格式库 API。迁移解码路径 `MigratingJsonlRows`（`.../generation.ts:305-480`）逐行读源行；对 V4 的这两个事件类型取源 `data.stream`，按源 seq（= 目标 seq）写旁挂，然后在 Worker 发布校验前完成 fsync。`JsonlGenerationFormatAdapter`（`.../generation.ts:58-68`）无需新方法。
- 不破坏已发布数据：V4 世代文件的原路径、字节、inode 一律不动，只**新增** V5 世代与 `streams.v1/` 目录；沿用「相邻迁移只能新增版本、绝不移动/覆盖/删除已提交世代」（`.agents/notes/implemented/architecture/2026-08-31-released-session-format-migrations.md:114`）。
- 磁盘代价（必须写进运维文档）：V4 会话迁移后 = V4 原文件 + V5 主日志 + 旁挂 ≈ 原来 2.5 倍，且 V4 不能删。旁挂全量与 stream 同量级（本机 29.28 MB / 19 会话），需给出清理/归档策略（待定：是否允许运维手工归档 V4 世代，产品不做）。

## 6. 失败模式与风险清单

| 风险 | 触发 | 影响 | 处置 |
|---|---|---|---|
| fork/导出遗漏旁挂 | 消费方未同步改 | 继承段无法回放、导出不可还原 | fork 复制（待定）+ 导出带目录 + 快照回归 |
| 磁盘膨胀 | 懒迁移累积 V4+V5+旁挂 | 小内存主机磁盘吃紧 | 运维文档 + 可选「只保留 V5 支线」归档指引 |
| 文件数 | 每会话约 1 条流/事件（本机均值 1,836 条/会话） | Windows 目录遍历、备份变慢 | 可退回「每会话单文件 + 索引」变体（成本更高） |
| 迁移边丢流 | tee 与 stage 判定不一致 | 不可回放且无 V4 兜底 | 迁移后抽样比对 `stream` 与 `message.content` 一致性；失败即拒绝发布 |
| 同步读旧 API | 遗漏 `event.data.stream` | 编译期即失败（类型删除） | 靠类型系统全量暴露，不靠 grep |
| 旧版本混跑 | V4 构建读 V5 | 直接拒绝并提示升级 | 已有 `refuseForeignFormatVersion`（`format.ts:340-346`） |
| 校验弱化 | 移除内嵌流校验 | 损坏内容进历史 | 校验前移到迁移边 + Worker 发布校验 |

## 7. 测试计划

- 单测：旁挂命名/压缩/幂等复用/损坏拒绝；carrier 认领与未认领丢弃；`Session.append` 不接受流载荷。
- 格式边：V4 fixture → V5，断言 seq/继承切点/`usage`/`firstTokenTime`、其它事件逐字节保留、`stream` 全部落到旁挂；拒绝用例（未知必选事件、非法流、内容与 message 不一致）。
- 持久化：崩溃注入（旁挂失败、主日志失败、两者之间）、读打开不写盘、写打开发布后追加、V4 世代字节不变（哈希比对）、V5 会话缺旁挂的降级路径。
- 快照：`pnpm run test:snapshot`（keyless 录制回放）保持绿；按 `docs/cookbook/adding-a-session-format-version.md:85-96` 新增 V5 后继 fixture，历史文件不改名、不改内容。
- 真实数据回放：用 19 个本机会话（`docs/memory-optimization/01-root-cause.md:16`）做只读拷贝，断言迁移后主日志 ≈ 30.1 MB、旁挂 ≈ 29.28 MB、`deriveMessages()` 前后全等、`usage`/首字延迟数字全等。
- 门禁：新包 per-file 100% 覆盖（CI 覆盖门），并补 `pnpm run verify-session-format-catalog` 与迁移脚本的 dry-run 测试。

## 8. 工作量与风险

- 总量：**L**。拆分：格式边+codec+catalog+版本号 **M**；JSONL 后端旁挂写/读/tee/校验 **L**；agent-loop carrier 与 `Session` 改动 **S/M**；消费方 9 处 + 客户端 wire/UI **M**；迁移脚本 + 语料/fixture **M**；测试与快照 **L**。
- 最大风险：**写入一致性（§3 的顺序保证）与消费方遗漏**——前者决定「主日志不产生无旁挂的流事件」，后者决定产品体验是否退化；两者都必须靠测试而不是评审兜住。
- 次风险：fork/导出语义与磁盘膨胀，属于可降级的产品决策，需要 release 前明确写进升级指南。
