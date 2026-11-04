# dsh web 内存占用问题 · 本地复核报告

> 复核对象：`wings1848/morphofly-dsh` issue #1 的根因分析 ｜ 复核时间：2026-11-04 ｜ 代码基线：`master @ fcc0ad46`（dsh 0.2.2-rc.1） ｜ 数据来源：本机 `C:\Users\butte\.dsh\sessions` 的 19 个真实会话

## 一、结论

1. **根因方向成立**：`assistant/message.stream` 确实占了会话数据的大头，且其中的模型输出文本与 `message.content` **100% 重复**，模型历史重建（`deriveMessages`）确实不读它。
2. **数字要改**：本机实测 stream 占全部会话数据 **49.3%**（issue 写 62%）；`assistant/message` 这一类事件占 **65.8%**。差距来自工作负载不同（本机 tool/result 占比更高，17.8%）。
3. **方案 D 在本机没复现**：runtime-context 快照只有 0.1% 的数据量，"每步新增完整副本"的现象在本机不存在（上游 10-22 的 prompt 前缀修复可能已经覆盖了一部分）。
4. **官方未修复**：截至 0.2.2-rc.1（2026-11-04 发布），格式仍是 V4 内嵌 stream，日志仍无上限，会话仍常驻；相关 discussion 全部 open 且没有任何官方回复。

## 二、实测数据

样本：19 个会话，压缩后 17.0 MB → 解压 59.4 MB，共 15,082 条事件。

### 事件类型占比（前 5）

| 事件类型 | 条数 | 解压后大小 | 占全部数据 |
|---|---:|---:|---:|
| `assistant/message` | 1,836 | 39.13 MB | **65.8%** |
| `tool/result` | 2,685 | 10.61 MB | 17.8% |
| `tool/call` | 2,671 | 2.52 MB | 4.2% |
| `user/message` | 280 | 2.25 MB | 3.8% |
| `job/settled` + `job/registered` | 3,014 | 2.86 MB | 4.8% |

### `assistant/message` 内部

- `stream` 字段：**29.28 MB**（报告的 75%）
- `message` 字段：9.43 MB
- **stream 是 message 的 3.10 倍**

### `stream` 里面到底是什么

| 组成 | 大小 | 占 stream | 说明 |
|---|---:|---:|---|
| `texts`（流式文本片段） | 9.68 MB | 33.1% | 5,454,582 字符，与 message 文本 **100.0% 重复** |
| `block-end`（每块完整内容） | 8.07 MB | 27.6% | 5,454,364 字符，**又一次 100% 重复** |
| `dt`（逐 chunk 时间戳数组） | 4.39 MB | 15.0% | 2,057,325 个数字，纯时序标记 |
| `tool-call` 参数 | 4.01 MB | 13.7% | 与 `tool/call` 事件重复 |
| `finish` / `replayState` | 1.25 MB | 4.3% | 签名与重放状态 |
| `block-start` | 0.45 MB | 1.6% | 结构标记 |
| `usage` | 0.31 MB | 1.0% | 与 `usage?` 字段重复 |
| JSON 键名开销（估算） | 1.58 MB | 5.4% | 每条记录重复同样的键名 |

**关键结论：同一段模型输出在日志里存了 3 份**（stream.texts、stream.block-end、message.content）。
另外 18.8% 的 stream 是纯时序/结构标记，对模型历史毫无用处。

### 能省多少

- 直接去掉 `stream`：会话数据 59.4 MB → 30.1 MB，**省 49.3%**
- issue 里的方案 A（stream 旁挂文件 + 按需读取）能拿到同等收益，但保住时序信息

## 三、issue 各条断言的核对

| # | issue 断言 | 本机核对 | 结论 |
|---|---|---|---|
| 1 | `deriveMessages()` 不读 stream | 代码 `surface.ts:667` 只走 `event.data.message` | ✅ 成立 |
| 2 | stream 文本与 message 100% 重复 | 5,454,582 vs 5,454,364 字符 | ✅ 成立（100.0%） |
| 3 | usage 已独立存储 | `types.ts:355` 有独立 `usage?` 字段 | ✅ 成立 |
| 4 | 完整性校验只在专用路径 | `generation.ts:545` 的 `assertCurrentAssistantStreams` 只在隔离校验里调用 | ✅ 成立 |
| 5 | stream 占会话数据 62% | 本机 49.3% | ⚠️ 数字偏高，方向对 |
| 6 | 方案 D：投影每步新增完整副本（119–202 MB） | 本机 runtime-context 快照仅 35 条 / 0.08 MB = 0.1% | ❌ 本机未复现 |

## 四、为什么官方不好修：还依赖 stream 的代码点

`stream` 不是纯冗余，下面这些地方会在没有等价数据时读到它：

| 位置 | 用途 |
|---|---|
| `packages/llm/token-meter/src/usage-projection.ts:85` | usage 兜底（`data.usage` 缺失时） |
| `packages/llm/token-meter/src/turn-usage.ts:233,246` | 同上 |
| `packages/bundle/headless/src/json-stream.ts:270,273` | headless 输出用量 |
| `packages/session/session-stats/src/projection.ts:135,142` | 首字延迟（UI 统计） |
| `packages/llm/token-meter/src/measurement-projection.ts:70` | `assembleAssistantStream` 重建块 |
| `packages/subagent/subagent/src/assistant-output.ts:38` | 子代理输出文本 |
| `packages/session/session-persistence-jsonl/src/generation.ts:560` | 隔离校验 |
| `packages/session-query/session-log-export/src/archive.ts:274` | 导出 |
| `packages/session/session-format-v{1,2,3}-to-*` | 历史格式迁移 |
| 客户端 live 重放 / 断线重连 | 未完成消息的流式渲染 |

所以方案 A（旁挂文件 + 双读路径）不是"删个字段"，而是一次**会话格式演进**（V4→V5）+ 迁移 + 多消费方改造，这也是上游迟迟不动的原因。

## 五、复现命令

```powershell
cd D:\Code_Project\morphofly-memory-check
node analyze-sessions.mjs     # 事件类型占比、会话总量
node stream-breakdown.mjs     # stream 字段组成拆解
```

脚本只读 `C:\Users\butte\.dsh\sessions`，不解压落盘、不改任何文件。注意：DSH 运行时会持续追加会话，两次运行的数字会有少量漂移（正常）。

## 六、官方状态（截至 2026-11-04）

- 代码：`SESSION_FORMAT_VERSION = 4`、`assistant/message.stream` 仍在、`private log` 仍无上限、会话仍常驻
- discussion：#4722 / #4678 / #10837 / #11608 / #11689 全部 open，**0 条官方（MEMBER/COLLABORATOR）回复**
- 发布：v0.2.2-rc.1 只有一条相关性能优化（"降低长回复流式组装的运行时成本"），不涉及常驻内存根因
