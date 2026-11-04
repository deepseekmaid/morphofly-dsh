# stream 消费方审计与常驻内存路径（方案 B/C 可行性）

> 基线：`master @ fcc0ad46`（dsh 0.2.2-rc.1）｜范围：`packages/**/src`，不含 `tests/` ｜ 数据依据：[01-root-cause.md](../01-root-cause.md)（stream 占 49.3%，文本与 `message.content` 100% 重复）结论先行：V5（stream 旁挂）真正的难点不是持久化，而是**同步投影里读完整 stream 的 11 处产品消费方**；B 需先改会话读契约且收益被 V5 吃掉大半；C 客户端基础设施已够、host 缺的是 handle 所有权与"驱逐≠删除"语义。

## A. 读 `event.data.stream` 的消费方

### A1 产品路径（11 处，直接读字段）

| file:line | 用途 | 需要什么 | V5 后取数 | 影响模型可见历史？ |
|---|---|---|---|---|
| `llm/token-meter/src/usage-projection.ts:82-86` | usage 兜底（`data.usage` 缺失时） | 只要 usage | `assistant/attempt` 事件补 `usage?` 字段（`message` 已有，`types.ts:355`；attempt 没有，`types.ts:363`） | 否 |
| `llm/token-meter/src/turn-usage.ts:77-78,226-251` | 重试 turn 计费 | 只要 usage | 同上 | 否 |
| `llm/token-meter/src/measurement-projection.ts:61-77` | 用量锚点估算 assistant tokens（`assembleAssistantStream().blocks()`） | 完整块内容 + usage | 改用 `deriveEventMessage(event).message` 的 content（实测与 block-end 100% 重复）；**投影 `apply` 必须同步**（`session-projection/src/index.ts:76-81`），不能异步读旁挂 | 否，但影响 token 测量/压缩判断 |
| `bundle/headless/src/json-stream.ts:191-192,267-274` | headless JSON 输出 usage | 只要 usage | attempt 补 `usage?` | 否 |
| `session/session-stats/src/projection.ts:132-159` | ttft/decode 统计（host 投影） | 只要首 token 时间 | 结算事件补 `firstTokenTime`，或用已持久化的投影缓存；live 帧 `assistant/live-chunk` 自带 time | 否 |
| `experimental/client-ui-stats/src/client/stats-fold.ts:418-436` | 客户端 ttft 回填 | 只要首 token 时间 | live chunk 已覆盖（同文件 418-427）；历史帧读 `sessionStats` 投影 | 否 |
| `client/ui-trajectory/src/client/trajectory-assistant-definition.ts:193-201` | 客户端首 token 时间 | 只要首 token 时间 | 同上；`assistantStreamFirstTokenTime` 可留作 live 兜底 | 否 |
| `subagent/subagent/src/assistant-output.ts:32-40,67-75` | 子代理最终输出兜底文本 | 只要文本/partial | message 分支已有 `message.content`；attempt-only 兜底需旁挂或降级 | **是**：兜底文本进父代理结果（模型可见），漏改会改变语义 |
| `experimental/session-inspector/src/client/views/session-log/model.ts:186-195` | 调试器逐 chunk 展示 | 必须完整 stream | 按需异步取旁挂（纯 UI，可异步） | 否 |
| `session/session-persistence-jsonl/src/generation.ts:553-575` | 隔离完整性校验（content/usage/replayState 与 stream 一致） | 必须完整 stream | host 异步路径读旁挂；旁挂必须与日志同代、同生命周期 | 否 |
| `session-query/session-log-export/src/archive.ts:231-281` | 导出时从 `block-end` 收集附件引用 | 必须完整（block-end 块） | 导出前异步读旁挂，或在事件里保留附件引用清单 | 否 |

另有 2 处 test-support（`test-support/llm-replay/src/index.ts:503-505` 回放重建 chunk、`test-support/loader-smoke/src/agent-turn.ts:88-99` usage）需要跟随迁移。

### A2 旧格式 reader（V5 不能删，必须继续读 V1–V4 内嵌 stream）

`session-format-v0-to-v1/src/codec.ts:242-285`、`v1-to-v2/src/migration.ts:213,543-562` 与 `src/testing/validation.ts:67`、`v2-to-v3/src/payload.ts:157-158`、`v3-to-v4/src/content.ts:84-91`、`developer.ts:92-93`、`retired-syntax.ts:64-65`。结论：新增 v4→v5 邻接迁移即可，旧边不动。

### A3 载体（不读字段，但整包搬运 stream —— 决定 V5 实际收益）

| file:line | 行为 | V5 必做决定 |
|---|---|---|
| `api/session-controller/src/history.ts:174-180` | `entryFor` 把整条事件原样上 wire | 不裁剪 → Web 客户端窗口仍持有 49% 的 stream；建议 history 页不带 stream，inspector 按需拉 |
| `api/session-controller/src/history/listener.ts:8,77` | live 帧整条转发 | 同上 |
| `api/session-controller/src/client/sessions/session.ts:669-706` | 客户端 `eventSource` 长期保存整条事件 | 同上，客户端内存收益全靠这里 |
| `session/session-log-deepseek/src/index.ts:90-123` | 上传给 provider 的会话日志整包带 `data` | 需明确是否随 V5 一起旁挂（否则上传丢失 stream） |
| `core/agent-loop/src/agent.ts:505-582`、`assistant-stream.ts:112-114` | 生产者把累积 stream 写进事件 | V5 的写入点：旁挂写盘 + 事件保留摘要 |

> 已核对但与 V5 无关：`api/session-controller/src/client/sessions/assistant-stream.ts:80-82` 读的是进程内重连 baseline（wire 瞬态，不是 durable 字段）。**`deriveMessages` 不变量**：`core/session/src/surface.ts:667-671` 只走 `event.data.message`，以上直接读者均不参与历史重建；唯一会改模型可见语义的是 A1 的 `assistant-output.ts`，次要是 measurement 影响压缩阈值。

### A4 V5 取数模式结论

- **同步旁挂读写不可行**：会话投影契约要求 `apply` 同步（`session-projection/src/index.ts:76-81`），热路径上不能读文件。
- 正确形态：事件保留**紧凑摘要字段**（`usage`、`firstTokenTime`；必要时附件引用清单），完整时序 stream 进旁挂，按需**异步**读取只给 inspector/export/校验/回放。
- 若不做 wire 裁剪（A3），V5 只降 host 内存，Web 客户端内存不变。

## B. 有界常驻窗口 + 磁盘全量

### B1 需要改的契约（file:line 证据）

| # | 契约 | 现状证据 | 改动 |
|---|---|---|---|
| B1 | `seq = log.length`、`eventAt(seq)=log[seq]`、`snapshotEvents` 按索引切片 | `core/session/src/index.ts:714-737,759-762`；seed 连续性校验 `655-657` | 引入 `baseSeq` 偏移 + 异步历史读；窗口外读盘 |
| B2 | 派生历史按绝对 seq 索引 log；header/context/tool fold 用 index 当 seq | `index.ts:1008-1012`（`log[seq]`）、`928-971` | 改为 `log[seq-baseSeq]`；fold 水位改偏移。`SurfaceManager` 已接受 `baseSeq`（`surface.ts:621-631`，注释明确支持"loaded event window"），有部分地基 |
| B3 | 派生消息缓存必须整段保留（model-visible 不变量） | `index.ts:974-1020` | 窗口只能省原始事件；`deriveMessages` 结果不能淘汰 |
| B4 | fork 需要全量前缀且 boundary 必须连续存在 | `index.ts:1403-1454`、`fork.ts:21-29` | fork 改异步读盘，或窗口不淘汰 fork 需要的前缀 |
| B5 | 历史/检索/导出统一读 `session.snapshotEvents()` 全量 | `session-query/src/observation.ts:301-305`、`corpus.ts:254,309`；`session-query-sqlite/src/index.ts:873`；分页按绝对 seq 索引 `api/session-controller/src/history.ts:139-166` | 需"live tail + 磁盘前缀"拼接；冷读前先 `sessions.flush` 保证磁盘覆盖 |
| B6 | 投影重建全量 fold | `session-projection/src/index.ts:847,903`；水位要求 `session-projection-cache/src/spec.ts:22-41` | 无缓存时必须从磁盘重建（贵，且期间内存出现全量副本） |
| B7 | 同步增量读者依赖"未淘汰"的事件 | `token-meter/src/index.ts:245-248`（watermark 落后）、`skill/tool-skill/src/index.ts:386`、`session-log-deepseek/src/index.ts:213`（上传积压） | 淘汰前必须 pin/flush，否则读空 |

### B2 收益评估

V5 已拿走 49.3% 的 stream；B 额外可省的只有非 surface 事件（tool/call 4.2%、job 4.8%、turn/step 边界）与 message 事件里的重复载荷（9.4/59 ≈ 16%）。但 `tool/result` 17.8% 与 user message 属模型可见，派生消息与事件共享冻结对象，淘汰前需复制 → 内存中性。**结论：需先改契约，风险等级高；V5 之后单独做 B 收益有限，不建议先做。**

## C. 空闲会话卸载

### C1 现有基础设施

| 面 | 证据 | 判断 |
|---|---|---|
| 客户端生命周期 | `retain/release` → `retireScope` → `manager.drop` → `Session.dispose`：`client/sessions/service.ts:301-314,562-614`、`manager.ts:191-198`、`session.ts:600-612` | **够用**：引用归零会卸载（含事件流） |
| 客户端常驻声明 | `session.ts:1` 注释明写"创建后常驻"；`manager.ts:102-106` 投影值仓按 id 常驻 | 缺"空闲"触发与显式休眠信号；投影仓无淘汰 |
| Host 重开路径 | 冷读 `session-query/src/observation.ts:98-163` → `agents.resume`（`session-controller/src/agent.ts:284-318`）；客户端 `resync()`（`session.ts:499-511`） | **够用**，重开不需要新机制 |
| Host 卸载能力 | `AgentHandle.dispose` 存在（`core/agent/src/index.ts:160-162`）；handle 的 effect 归 AgentRegistry 自身 ctx（`429-434`） | 能力有，但没人持有 handle |

### C2 缺口与竞态

| # | 问题 | 证据 | 说明 |
|---|---|---|---|
| C1 | 每个打开过的会话都留活 Agent + 全量 `Session.log` | `agent.ts:313-318` 把 `AgentHandle` 丢掉只返回 `.agent`；`web/controller.ts:62-71` 每次 follow 都 promote；客户端固定 `activate: true`（`client/transport.ts:181`） | 这是 host 常驻的根因，不是客户端 |
| C2 | "驱逐"不得复用 `session/disposed` | `session/disposed` → `api-session/removed`（`session-controller/src/index.ts:227-229`）→ 客户端 `removed` 标记并禁用输入（`manager.ts:684-691`；`ui-conversation/src/client/stop-shortcut.ts:48`、`skeleton/InputBar.tsx:82`、`input/hub.ts:132,224`） | 必须新增独立事件/通道，否则 UI 把休眠误判为删除 |
| C3 | 驱逐前必须持久化且不能打断运行/在飞工作 | `sessions.flush` 屏障 `core/session/src/index.ts:1342-1359`；running/inbox 判定 | 需 idle 判据：非 running、inbox 空、无 pending submission、flush 成功 |
| C4 | 并发竞态已有部分防护 | resume 去重 `agent.ts:117,175-179`；promote 在飞集合 `index.ts:203-205,262-263`；append 期间延迟 detach `index.ts:886-911,1251-1263` | 仍需处理：驱逐与 promote 撞车、驱逐与客户端 follow 撞车（`history/listener.ts:37` 订阅 `session/event`，Session 消失后订阅静默停止，需要驱逐/重开信号让客户端 resync） |
| C5 | opencode 两次同类 PR 被关的教训 | 外部信息，未在本仓库复核（待补充链接） | 共性风险与 C2–C4 一致：删除/休眠语义混淆 + running 竞态 + 重开风暴 |

### C3 结论

- **客户端**：可直接做（基础设施已具备），风险低；只需补空闲策略与投影仓淘汰。
- **Host**：**需先改契约**（handle 所有权 + 独立驱逐事件 + idle/运行判据 + flush/follower 信号），风险中。最小可行版＝"显式休眠/唤醒"或"idle ≥ N 分钟且非 running、无 follower、flush 完成才 dispose handle，保留磁盘"；不要做无上限自动卸载。
- **B 与 C 的关系**：C 能立刻把 host 常驻集合从"打开过的所有会话"收回到"当前活跃"；B 解决单个大会话的峰值。若只做一件事，先 C（收益/风险比最好），再 V5，最后才考虑 B。

## D. 复现命令

```powershell
cd D:\Code_Project\morphofly-dsh
rg -n "\.data\.stream|expandAssistantStream|assembleAssistantStream|joinAssistantStreamText|assistantStreamFirstTokenTime|lastAssistantStreamChunk" packages --glob "packages/**/src/**/*.ts"
rg -n "private log|snapshotEvents|eventAt|seq = log.length" packages/core/session/src/index.ts
rg -n "retain\(|retireScope|manager\.drop|activate: true|session/disposed" packages/api/session-controller/src
```
