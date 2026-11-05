# Agent Note: Package and distribute the personal distribution without an npm package or desktop installers

Status: rejected — the fork cannot publish upstream's npm scope, and signed desktop builds need paid accounts this distribution does not have

English | [中文](2026-11-05-personal-distribution-packaging.zh.md)

## Problem

`morphofly-dsh` is the owner's personal distribution: `master` mirrors upstream and `custom` carries local changes, and the release lane produces one self-contained workspace tarball that a target host extracts without installing or building. Operators asked whether a tagged release should additionally publish the CLI and Web UI as an npm package for `npm install -g`, and build Linux, Windows, and macOS desktop installers so other people could install the distribution like a product instead of extracting a tarball.

## Proposal

Tag a release, publish the CLI and Web packages to npm from CI, build desktop installers for Linux, Windows, and macOS on hosted runners, and attach every artifact to the GitHub Release.

## Alternatives considered

**Publish the workspace under a fork-owned npm scope.** The workspace publishes as `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*`, a scope only the upstream organization owns, so a fork cannot publish those names. Rescoping hundreds of packages, the CLI bin, generated catalogs, and plugin resolver manifests is mechanically large, and it breaks third-party plugins: their peer dependencies name `@deepseek-ai/dsh-*`, so a rescoped distribution would not load the plugins the owner actually uses. Every upstream sync would replay the rename. Rejected.

**Publish a thin wrapper package that depends on upstream `@deepseek-ai/dsh`.** The distribution's changes — idle Agent release, and the planned session-format V5 — live inside workspace packages, so a wrapper cannot carry them; publishing unpatched upstream packages would misrepresent the distribution. Rejected.

**Build signed desktop installers.** The desktop application's owning decision packages only `mac-arm64`, `mac-x64`, and `win-x64`, and its release lane requires Apple Developer notarization credentials for macOS, a Windows EV code-signing certificate and token, and a release upload target ([Desktop packaging and updates](../../implemented/architecture/2026-08-25-electron-desktop-packaging-and-updates.md)). None of that exists for the fork, and signed builds are meant to feed its own update stream, not GitHub Release assets. Rejected.

**Build unsigned desktop installers on hosted runners.** Feasible without credentials, but it adds a release lane that must be re-validated after every upstream sync, while the only desktop user is the owner, who already reaches the same Web UI on a server host. Linux desktop packaging does not exist upstream at all, so it would also require a new packaging target. Not worth the maintenance yet.

**Keep the GitHub Release tarball and install/deploy scripts (chosen).** The current release lane already produces the full-workspace tarball with sha256 and manifest, and the deployment scripts extract it remotely without installing or networking on the target. That covers this distribution's users — the owner's own machines and anyone able to run the install script — and keeps one verified path from build to production. npm publication, desktop installers, and signed builds stay deferred; revisit only when external users who cannot run a shell install need them.

## Consequences

- One artifact path stays authoritative: GitHub Release tarball, then the deploy scripts. No npm publishing credentials, no signing accounts, no additional platform lanes to keep working across upstream syncs.
- People without shell access to a supported host cannot install the distribution through a package manager or a graphical installer.
