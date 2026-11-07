---
kind: upgrade-guide
description: "存储日志不再装得下空闲堆时，冷打开会话会被拒绝。"
---

# 会话不再装得下空闲堆时，冷打开会被拒绝

[English](guide.md) | 中文

## 变更

`observeSession` 在读取存储日志之前先为冷打开定价：用 `stat().sizeBytes` 报告的产物大小乘以 `coldOpenHeapMultiplier`，再与空闲 V8 堆的 `coldOpenHeapShare` 比较。估算装不下时读取以 `SESSION_QUERY_SESSION_TOO_LARGE` 失败，消息给出存储大小、估算值与空闲堆。拒绝发生在打开日志之前，因此不会物化任何会话，宿主保持原有堆占用。

prepared-Session 缓存在条目上限之外增加字节上限：`preparedSessionCacheBytes` 限制未被租约钉住的条目所保留的估算堆，按最久未用淘汰直到估算总量装下。

## 迁移

无需迁移。会话装得下堆的宿主行为不变；过去能打开超大会话随后陷入换页的宿主，现在会得到可读的失败。后端组合设置三个继承的旋钮：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `coldOpenHeapShare` | `0.5` | 单次冷打开可估算占用的空闲 V8 堆比例；`0` 关闭护栏 |
| `coldOpenHeapMultiplier` | `8` | 每存储产物字节对应的估算堆字节 |
| `preparedSessionCacheBytes` | `128 MiB` | 未被租约钉住的冷观察保留的估算堆；`0` 关闭字节上限 |

`SessionObservationReader` 保留 `(ctx, cacheCapacity?)` 构造形式，并为直接构造读取器的调用方新增可选的第三个 limits 参数。

护栏是估算而非实测。不报告 `sizeBytes` 的后端无法定价，会被放行；估算低于真实成本时仍会物化日志。要打开超过堆上限的会话，提高宿主堆仍是唯一办法。
