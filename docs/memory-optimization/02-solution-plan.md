# 内存问题解决方案（评审稿）

> 基线：`master @ fcc0ad46`（dsh 0.2.2-rc.1）｜实测：见 [01-root-cause.md](01-root-cause.md)（stream 占会话数据 49.3%，与 `message.content` 100% 重复） ｜ 调研：`drafts/` 下三份（格式设计、消费方审计、迁移约定），本文件是汇总后的决策建议。**状态：待审核，未实施任何代码改动。**

## 一、结论先行

这个问题不是一个补丁能修的，是**三块独立的内存来源**，要分开打：

| # | 来源 | 现状 | 对症方案 | 预期收益 | 工作量 | 风险 |
|---|---|---|---|---|---|---|
| 1 | 打开过的会话永久常驻（拿到 Agent 就丢 handle，从不卸载） | `api/session-controller/src/agent.ts:313-318`、`client/sessions/session.ts:1` | **C：空闲会话卸载** | host 常驻集合从"打开过的全部"收回到"当前活跃" | M | 中（要新驱逐语义，不能复用"删除"） |
| 2 | 单会话日志里 stream 冗余（49.3%）+ 全量上 wire 到 Web | `core/session/src/types.ts:354`、`api/session-controller/src/history.ts:174` | **V5：stream 旁挂 + wire 裁剪** | 单会话数据/内存 -49.3%，客户端同步受益 | L | 中高（格式迁移，首次"已发布格式再升版本"） |
| 3 | 单会话日志本身无上限 | `core/session/src/index.ts:526` | **B：有界常驻窗口** | 理论上限，但 V5+C 之后只剩 16–20% 可省 | XL | 高（`seq=log.length` 等契约全要改） |

**建议：先 C（止血、性价比最高）→ 再 V5（结构性、拿一半）；B 暂不做；方案 D 放弃（本机未复现）。**
**但如果你本轮只想要"验证 issue #1 的结论是否成立"，就先做 0.5 的实验版（见下），一天内能出数据。**

## 二、推荐路线（分阶段，每阶段可独立验收）

### 阶段 0：可观测 + 立即可用的缓解（不碰核心，1 天）

- 已有社区插件 [dsh-log-trim](https://github.com/DDDMUC/dsh-log-trim)：启动时裁掉模型已看不见的死尾巴（实测 13.2MB→4.8MB）。只治磁盘，治不了运行中的内存，配重启才有用。
- 本机加内存观测：定期采样 RSS/swap（`dsh web` 进程），建立基线。没有基线就无法验收后面任何改动。

### 阶段 0.5：一次性实验，验证"stream 到底占多少内存"（1–2 天，不改格式）

不改任何持久化格式，只在**加载后**从事件里就地丢掉 `stream`（进程内实验补丁），对比：

- 冷启动 RSS（19 个会话全开）
- 单长会话跑 5 小时的峰值
- `deriveMessages()` 输出是否逐字节一致

这一步花 1/10 的力气就能回答"值不值得做 L 级改动"，也直接给上游 discussion 提供硬数据。**建议先做这一步再决定是否进入阶段 2。**

### 阶段 1：空闲会话卸载（方案 C，M）

- **Host**：`api/session-controller/src/agent.ts:313-318` 目前 `resume()` 返回后只留 `.agent`，丢弃 `AgentHandle`——没有人能 dispose，这是"打开过就永久常驻"的根因。需要保留 handle、加空闲判据与受控 dispose。
- **必须新增独立"休眠"事件**：不能复用 `session/disposed`（会映射成 `api-session/removed`，UI 会误判"会话被删"并禁用输入：`manager.ts:684-691`）。
- **驱逐条件（缺一不可）**：非 running、inbox 空、无 pending submission、无 follower、`sessions.flush()` 成功、空闲 ≥ N 分钟。
- **客户端**：基础设施已够（`retain/release → retireScope → drop → dispose` 引用归零即卸载），只需补空闲策略与投影仓淘汰；风险低。
- 可先做最小版：**显式"休眠/唤醒"**（用户手动或定时），稳定后再自动化。

### 阶段 2：V5 旁挂（方案 A，L）

设计要点（`drafts/format-v5.md`）：

- 旁挂位置：`<sessionDir>/streams.v1/s<seq>.jsonl.zstd`，一事件一文件，**文件名即 seq 主键**，不引入 `streamRef`（零悬空引用）。
- 事件瘦身：`assistant/message` 删 `stream`，补 `firstTokenTime`（同步投影拿不到异步 I/O）；`assistant/attempt` 删 `stream`，**补 `usage`**（否则丢账）。
- 写入顺序（最大风险点）：stream 不进 `Session.log`，走 `Session.append()` 的 carrier 旁路，由 JSONL provider 认领；**先 fsync 旁挂、再追加主日志行**，崩溃窗口有明确恢复矩阵。
- 迁移：**懒迁移**。读打开只在内存转 V5 视图（不写盘），写打开才发布 V5 代际 + 旁挂；V4 文件字节/路径零改动。
- 必须一起改的消费方（9 处产品路径）：usage 兜底 3 处、首字延迟 3 处、块重建 1 处、子代理输出 1 处、导出 1 处；校验从事件内嵌流前移到迁移边。
- **wire 裁剪**：`history.ts:174` 把整条事件发给客户端；不在 history 页去掉 stream，Web 客户端内存不会降——只降 host 内存。
- 上游规范要求 14 个交付项 + 6 个 review 门（`drafts/migration-conventions.md`），首次"已发布格式再升版本"，无干净先例。

### 阶段 3：B（有界窗口）—— 暂不做

需要改 `seq=log.length`、`eventAt(seq)=log[seq]`、fork 全量前缀、observation/检索、投影重建等一批契约；V5 之后额外收益只剩 16–20%，风险最高。记录在案即可。

## 三、为什么不走其他路

| 方案 | 否决理由 |
|---|---|
| 插件层直接修 | 事件格式、`Session.log`、会话常驻都在核心层，插件改不了；插件最多做磁盘裁剪（dsh-log-trim） |
| 方案 D（修投影去重） | 本机实测 runtime-context 快照只占 0.1%，未复现；10-22 上游已修过相关前缀问题 |
| 在 V4 内删/搬 stream（不升版本） | 老读者会抛通用校验错并静默降级（`generation.ts:560`、`index.ts:293`）；升 V5 才有方向性拒绝 |
| 复用 spill / attachment / storage 存旁挂 | spill 不持久；attachment 是用户附件语义、无会话归属；storage 整文件重写。只有"会话自有目录伴生文件"贴合 |

## 四、验收标准（可判定）

| 指标 | 判定命令/方法 | 目标 |
|---|---|---|
| 单会话数据体积 | 迁移脚本 + 本机 19 会话样本 | 59.4 MB → 30.1 MB（-49.3%） |
| `deriveMessages()` 不变 | 迁移前后逐字节 diff | 完全一致 |
| 主日志字节不变（V4） | 迁移前后哈希比对 | 完全一致 |
| 冷启动 RSS | 阶段 0.5 实验 + 阶段 2 复测 | 建立基线后定目标（本机基线待测） |
| 长会话峰值 | 5 小时会话采样 RSS/swap | swap 0，峰值显著低于基线 |
| V4 会话可读 | 现有 fixture + 真实会话回放 | 全部可读 |
| 旧构建读 V5 | 用 rc.1 构建打开 V5 会话 | 方向性拒绝，不误读 |
| 客户端 wire 体积 | history 页响应字节 | 不带 stream，约 -49% |

## 五、开放问题（需要你拍板）

1. **目标定位**：只在自己 fork 里私用（可以省掉上游 14 项规范），还是准备回流上游 PR（要按上游清单全套交付）？
2. **磁盘代价**：懒迁移后 V4 不可删，会话磁盘约变 2.5 倍，能接受吗？（可加运维归档指引）
3. **优先级**：先做阶段 0.5 实验拿数据（1–2 天），还是直接上阶段 1 / 阶段 2？
4. 阶段 1 先做"显式休眠"还是直接做自动空闲卸载？

## 六、参考

- [01-root-cause.md](01-root-cause.md) — 实测数据与 issue 断言核对
- [03-upstream-status.md](03-upstream-status.md) — 官方处理状态
- [drafts/format-v5.md](drafts/format-v5.md) — V5 完整工程设计
- [drafts/consumers-and-retention.md](drafts/consumers-and-retention.md) — 11 处消费方 + B/C 可行性
- [drafts/migration-conventions.md](drafts/migration-conventions.md) — 上游 V5 必做 14 项
