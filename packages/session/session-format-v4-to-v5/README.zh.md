---
description: "完整的 V4 → V5 会话转换与原生准入：Assistant 流离开事件日志，结算标量保留，旁挂文件由持久化层拥有。"
kind: "package-library"
---

# @deepseek-ai/dsh-session-format-v4-to-v5

[English](README.md) | 中文

## 摘要

把受支持的已发布 V4 会话恢复为 V5，且不改写其已存储世代。转换从两个结算事件中删掉内嵌的 Assistant 流，逐字节保留 message 载荷，并推导同步消费方折叠所需的两个标量。`streams.v1/` 旁挂文件与后继世代发布由持久化层负责；本库只负责转换与目标格式规则，从不读写旁挂文件。

## 目录

- [使用本包](#use-this-package)
- [V4 → V5 规范](#v4-to-v5-specification)
  - [头部与物理框架](#header-and-framing)
  - [Assistant message 转换](#assistant-message)
  - [Assistant attempt 转换](#assistant-attempt)
  - [保留的坐标与时序](#preserved-coordinates)
  - [源审计与拒绝](#source-audit)
- [原生 V5 准入](#native-v5-admission)
  - [头部与结算载荷](#native-fields)
  - [校验入口与恢复](#native-recovery)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

完整恢复请使用[格式 catalog](../session-format-catalog/README.zh.md)。直接导入用于 catalog 组装与测试；本库没有 Cordis 挂载配置。其[公开导出](src/index.ts)提供相邻迁移、已发布 V4 源 codec、V5 codec、目标校验器与 V5 制品恢复器。源 codec 仍由 [V3 → V4](../session-format-v3-to-v4/README.zh.md) 拥有。

仅迁移头部只推进元数据，不读取正文：

```text
const targetHeader = sessionFormatV4ToV5.migrateHeader(sourceHeader)
```

正文转换是无状态、按制品进行的阶段；因为该边既不插入也不删除事件，每个序号都保持原值：

```text
const stage = sessionFormatV4ToV5.createStage({
  sourceHeader, targetHeader, sourceInheritedEventCount, sourceKind: 'decoded',
})
for (const event of sourceEvents) stage.transformEvent(event, context)
const targetInheritedEventCount = stage.finish(context)
```

<a id="v4-to-v5-specification"></a>
## V4 → V5 规范

<a id="header-and-framing"></a>
### 头部与物理框架

头部只把 `version` 从 4 转为 5。其余元数据字段的值与类型不变：`id`、`createdAt`、`cwd`、`parentSession`、`isSeeded`、`origin`、`delegationDepth`、`agentPreset`。物理 JSONL 框架不变；V5 codec 复用已发布的 V4 行框架并写入 writer 版本，因此没有物理重编码规则变化。

<a id="assistant-message"></a>
### Assistant message 转换

源载荷字段：`turn`、`step`、`message`、`stream`、`usage`、`interrupted`。

| 目标字段 | 规则 |
|---|---|
| `turn`、`step` | 源中必填，原样复制。 |
| `message` | 源中必填，原样复制且逐字节不变；它就是模型可见历史。 |
| `usage` | 存在时原样复制；源中缺失则目标也缺失。 |
| `interrupted` | 存在时原样复制；源中缺失则目标也缺失。 |
| `firstTokenTime` | 由被移除的流经 `assistantStreamFirstTokenTime` 推导；流中没有 token 时缺失。 |
| `stream` | 移除。持久化层迁移已存储世代时，会把同样的记录存到 `streams.v1/`。 |

<a id="assistant-attempt"></a>
### Assistant attempt 转换

源载荷字段：`turn`、`step`、`stream`。

| 目标字段 | 规则 |
|---|---|
| `turn`、`step` | 源中必填，原样复制。 |
| `usage` | 取被移除流中最后一个 `usage` 块；流未报告时缺失。 |
| `firstTokenTime` | 由被移除的流经 `assistantStreamFirstTokenTime` 推导；流中没有 token 时缺失。 |
| `stream` | 移除。 |

attempt 保留 `usage` 与 `firstTokenTime`，是因为同步统计折叠此前从内嵌流读取这两项；丢掉任一项都会改变重试或失败步骤上报的 token 与延迟数值。

<a id="preserved-coordinates"></a>
### 保留的坐标与时序

每个事件都保留类型字符串、`seq`、`time`、信封字段 `surfaceOp` 与 `ignorable` 标记。除两个结算事件外，其余事件以同一对象逐字节发出。继承切点是逻辑事件计数；该边保留它：解码器在 EOF 前无法提供时，从最后一个继承 `session/end-seed` 标记推导；提供的切点与该标记矛盾时拒绝。

<a id="source-audit"></a>
### 源审计与拒绝

出现下列情况时，该边拒绝转换且不发布部分后继世代：

- 结算载荷不是 JSON 对象；
- 结算载荷带有已发布源白名单之外的字段（未知字段可能获得新的目标含义）；
- Assistant message 结算缺少 `turn`、`step` 或 `message`；
- 源中没有 `stream` 数组；
- 流未通过 `expandAssistantStream` 的记录准入；
- 未作为种子的会话含有继承的 `session/end-seed` 标记；
- 作为种子的会话到达 EOF 仍无继承标记；
- 提供的继承切点与推导的标记切点矛盾。

`plugin:` 命名空间的插件记录与未知可忽略事件原样带过；该边不解释不透明载荷。

<a id="native-v5-admission"></a>
## 原生 V5 准入

<a id="native-fields"></a>
### 头部与结算载荷

头部字段集与 V4 完全相同，只把 `version` 固定为 5。结算载荷仅接受：

| 类型 | 允许字段 | 必做标量校验 |
|---|---|---|
| `assistant/message` | `turn`、`step`、`message`、`usage`、`interrupted`、`firstTokenTime` | `firstTokenTime` 存在时为非负安全整数。 |
| `assistant/attempt` | `turn`、`step`、`usage`、`firstTokenTime` | 同上；另 `usage.inputTokens` 与 `usage.outputTokens` 为非负安全整数。 |

任何其他字段（包括残留的 `stream`）都会被拒绝。所有非结算事件通过 V4 恢复器继承已发布的 V4 准入；V5 校验只增加上述结算规则。

<a id="native-recovery"></a>
### 校验入口与恢复

`assertReleasedV5Header` 校验头部元数据，`assertReleasedV5Settlement` 校验单个结算载荷，`restoreReleasedV5Artifact` 校验完整制品：先跑已发布的 V4 恢复，再对所有已知类型的 V5 结算做准入。`releasedV5SessionFormatCodec` 在 V5 头部与行之上提供解码与编码，复用已发布的 V4 物理框架。恢复策略由持久化层选择；制品恢复器执行严格校验，绝不回退到前一代。

<a id="understand-the-implementation"></a>
## 理解实现

`src/migration.ts` 持有相邻声明与按制品的阶段。`src/validation.ts` 持有目标头部、结算与制品准入。`src/codec.ts` 持有物理 codec，把 V5 头部版本映射到已发布的 V4 解码器与编码器。

<a id="further-exploration"></a>
## 延伸阅读

- [会话格式版本与发布状态](../../../docs/session-format-status.zh.md) —— writer 与发布权威。
- [历史格式参考](../../../docs/persistence-changes/historical-formats/README.zh.md) —— 该边转换的已归档 V4 schema。
- [会话持久化 JSONL 后端](../session-persistence-jsonl/README.zh.md) —— 拥有 `streams.v1/` 旁挂与后继世代发布。

<a id="model-experience"></a>
## 模型体验

本库不产生任何面向模型的文本、工具或提示词。转换逐字节保留模型可见的 `message` 载荷，因此迁移后的会话重建出完全相同的模型历史。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

该边只返回逻辑事件，既不读也不写旁挂文件。调用方若在没有负责 tee 被移除流的持久化层时转换已存储的 V4 世代，该世代的时序流就会丢失——这一保证由持久化层承担。fork 与归档路径必须自行复制或打包 `streams.v1/`。

<a id="dev-note"></a>
## 开发备注

无。
