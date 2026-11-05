---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-06-session-format-v5

[English](2026-11-06-session-format-v5.md) | 中文

## 概述

把已声明的 SessionHeader.version 从 4 推进到 5：两个 Assistant 结算事件都删除必填的已内嵌 `stream` 并新增可选 `firstTokenTime`，`assistant/attempt` 还新增可选 `usage`，被移除的流迁移到会话目录下的 `streams.v1/` 旁挂文件。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-06-session-format-v5
baseline: false
changes:
  - root: "SessionHeader"
    previous: "2026-09-16-session-format-v4"
    after: "22c6899a78214dd841c266348ae997027ef391174ddb21127f1b71dc1b362824"
    decision: version-bump
  - root: "event:assistant/attempt"
    previous: "2026-09-16-session-format-v4"
    after: "eb2e8ef1a8e29feab9c67af239ff11fbfcb0fa4447cb6947447f4f8df93bf8c3"
    decision: version-bump
  - root: "event:assistant/message"
    previous: "2026-09-16-session-format-v4"
    after: "11ba43079605f7723b9ad4f2e94251f2d0a55adcf0e22687aa234f17cc977e1f"
    decision: version-bump
```

<a id="compatibility"></a>
## 兼容性

持久化层把 V5 作为新 generation 发布在未改变的 V4 文件旁，因此既有 V4 会话保留其字节与路径；只读打开在内存中迁移受支持的 V4 generation，写打开发布 V5 后继并为每个被移除的流写一个旁挂。因此 V5 读取方能保留历史语义，而 V4 读取方会把 V5 日志当作更新的格式拒绝，而不会误解被移除的字段；不存在降级或回退。循环通过不持久化的 `Session.appendWithCarry` 载体把每个结算流移出事件，持久化写入方在同步事件派发期间用 `takeAssistantStream` 认领它；载体绝不进入日志。同步消费方读取记录下来的 `firstTokenTime` 与 `usage` 标量，精确的带时间流通过可选能力 `SessionHandle.readAssistantStream` 获取，其 V4 generation 句柄回退到内嵌行。旁挂缺失或不可读的结算会被明确拒绝；导出、fork 与备份必须带上 `streams.v1/` 目录。 相邻的 [V4 到 V5 迁移](../../packages/session/session-format-v4-to-v5/README.zh.md)负责转换与原生 V5 准入。

<a id="verification"></a>
## 验证

`vitest run packages/session/session-format-v4-to-v5/tests packages/session/session-persistence-jsonl/tests/streams.spec.ts packages/session/session-persistence-jsonl/tests/stream-sidecar.spec.ts`：5 个文件共 63 个测试通过。`tsx scripts/persistence-changes.ts --check` 报告已记录历史与当前 V5 目录一致。

<a id="dev-note"></a>
## 开发备注

无。
