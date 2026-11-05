# Agent Note: 个人发行版不发布 npm 包，也不提供桌面安装包

Status: rejected — the fork cannot publish upstream's npm scope, and signed desktop builds need paid accounts this distribution does not have

[English](2026-11-05-personal-distribution-packaging.md) | 中文

## Problem

`morphofly-dsh` 是仓库所有者的个人发行版：`master` 镜像上游，`custom` 承载本地改动；发布通道产出一份自包含的工作区整树 tarball，目标机只解包，不安装也不构建。操作者提出：打 tag 发版时，是否还应把 CLI 和 Web UI 发布成 npm 包（便于 `npm install -g`），并构建 Linux、Windows、macOS 桌面安装包，让别人像装产品一样安装这个发行版，而不是解压 tarball。

## Proposal

打 tag 发版时，在 CI 里把 CLI 与 Web 包发布到 npm，在托管 runner 上构建 Linux、Windows、macOS 桌面安装包，并把所有产物挂到 GitHub Release。

## Alternatives considered

**把工作区发布到 fork 自有的 npm scope 下。** 工作区以 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 发布，这个 scope 只有上游组织能发，fork 无法沿用这些名字。把数百个包、CLI bin、生成的 catalog 和插件解析清单全部改名，机械工作量很大，而且会破坏第三方插件：它们的 peer 依赖写的就是 `@deepseek-ai/dsh-*`，改名后的发行版将无法加载所有者实际在用的插件。此后每次同步上游都要重放一遍改名。否决。

**发布一个依赖上游 `@deepseek-ai/dsh` 的瘦包装包。** 这个发行版的改动——空闲 Agent 释放以及计划中的会话格式 V5——都在工作区各包内部，包装包无法承载；发布未打补丁的上游包又会让发行版名不副实。否决。

**构建签名的桌面安装包。** 桌面应用的既有决策只为 `mac-arm64`、`mac-x64`、`win-x64` 打包，且其发布通道要求 macOS 的 Apple Developer 公证凭据、Windows 的 EV 代码签名证书与硬件 token，以及发布上传目标（[桌面打包与更新](../../implemented/architecture/2026-08-25-electron-desktop-packaging-and-updates.zh.md)）。fork 这些都没有；签名构建本来就是喂给它自己的更新通道，而不是 GitHub Release 附件。否决。

**在托管 runner 上构建未签名桌面安装包。** 不需要凭据即可实现，但会多出一条每次同步上游都要重新验证的发布通道；而唯一的桌面使用者是所有者本人，他本来就能通过服务器上的 Web UI 达到同样效果。上游根本没有 Linux 桌面打包目标，做 Linux 还得新增打包目标。暂不值得这份维护成本。

**保留 GitHub Release 的 tarball 与安装/部署脚本（采纳）。** 现有发布通道已经产出带 sha256 与 manifest 的工作区整树 tarball，部署脚本在远端解包，目标机不安装、不联网。这覆盖了本发行版的使用者——所有者自己的机器，以及能运行安装脚本的人——并从构建到生产只有一条已验证的路径。npm 发布、桌面安装包与签名构建全部推迟；只有当无法运行 shell 安装的外部用户出现时才重新评估。

## Consequences

- 保持单一权威产物路径：GitHub Release tarball，随后走部署脚本。不需要 npm 发布凭据、不需要签名账号、不需要额外平台通道去跟着上游同步维护。
- 没有支持主机的 shell 访问权限的人，无法通过包管理器或图形安装器安装这个发行版。
