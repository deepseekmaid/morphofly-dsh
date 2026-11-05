#!/usr/bin/env bash
# Build the deployable artifact for the personal distribution: one zstd tarball of
# the complete workspace tree (sources + node_modules + built lib/dist) that the
# deployment target only extracts and links, without installing or building.
#
# `pnpm deploy --legacy` cannot produce this tree (it omits workspace-owned
# dependencies and leaves out-of-tree `link:` symlinks), and `release:pack`
# requires the official client build profile. Packing the tree that already
# passed `pnpm run build` avoids both.
#
# Preconditions: `pnpm run build:artifacts` plus the full native build
# (`pnpm --dir native/system run build:native`, needs musl-tools). The artifact
# gate only builds the host Node-API addon, so the static-musl `landlock-run`
# launcher exists only after the full build; step 0 rejects a tree without it
# instead of packing a release that cannot run `workspace-write` on a target
# without bubblewrap.
#
# Usage:
#   bash scripts/fork/build-fulltree-artifact.sh [--skip-smoke]
#
# Environment:
#   ARTIFACTS_DIR  output directory (default: <repo>/artifacts)
#   REPO           repository root (default: parent of this script's directory)
#   BUILT_ON       value recorded as `builtOn` in the manifest (default: hostname)
#   VERIFY_DIR     extraction directory for the smoke check (default: <artifacts>/.verify)
#
# Output (in ARTIFACTS_DIR):
#   dsh-<version>-<head9>.tar.zst
#   dsh-<version>-<head9>.tar.zst.sha256
#   dsh-<version>-<head9>.manifest.json
set -euo pipefail
export LC_ALL=C

LAUNCHER_PATH="native/system/packages/linux-x64/bin/landlock-run"

REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
ARTIFACTS_DIR="${ARTIFACTS_DIR:-$REPO/artifacts}"
VERIFY_DIR="${VERIFY_DIR:-$ARTIFACTS_DIR/.verify}"
SMOKE=1
for arg in "$@"; do
  case "$arg" in
    --skip-smoke) SMOKE=0 ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
step() { printf '\n[%s] ==== %s ====\n' "$(date +%H:%M:%S)" "$*"; }
warn() { printf '[%s] WARN: %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
die() { printf '[%s] FAIL: %s\n' "$(date +%H:%M:%S)" "$*" >&2; exit 1; }
bytes_human() { numfmt --to=iec --suffix=B "$1" 2>/dev/null || echo "$1 B"; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"; }

need tar
need zstd
need sha256sum
need node

cd "$REPO"

step "0. Preconditions"
HEAD_SHA="$(git rev-parse HEAD)"
HEAD_SHORT="$(git rev-parse --short=9 HEAD)"
VERSION="$(node -p 'require("./package.json").version')"
RELEASE_ID="dsh-${VERSION}-${HEAD_SHORT}"
ARTIFACT="$ARTIFACTS_DIR/${RELEASE_ID}.tar.zst"
MANIFEST="$ARTIFACTS_DIR/${RELEASE_ID}.manifest.json"
BUILT_ON="${BUILT_ON:-$(hostname)}"
mkdir -p "$ARTIFACTS_DIR"
log "repo=$REPO head=$HEAD_SHORT version=$VERSION"
[ -f apps/cli/lib/bin.js ] || die "missing apps/cli/lib/bin.js: run 'pnpm run build:artifacts' first"
[ -f apps/web/dist/index.html ] || die "missing apps/web/dist/index.html: run 'pnpm run build:artifacts' first"
[ -x "$LAUNCHER_PATH" ] || die "missing executable $LAUNCHER_PATH: run the full native build first ('pnpm --dir native/system run build:native'); it needs musl-tools/musl-gcc and produces the static Landlock launcher"
DIRTY="$(git status --porcelain | grep -v '^?? runs/' | grep -v '^?? artifacts/' | head -20 || true)"
DIRTY_COUNT="$(git status --porcelain | grep -v '^?? runs/' | grep -v '^?? artifacts/' | wc -l || true)"
if [ "$DIRTY_COUNT" != "0" ]; then
  warn "worktree has $DIRTY_COUNT uncommitted path(s); the artifact will contain them:"
  printf '%s\n' "$DIRTY" | sed 's/^/         /'
fi

step "1. Pack the workspace tree"
time tar --zstd -cf "$ARTIFACT" \
  --exclude=./.git \
  --exclude=./runs \
  --exclude=./artifacts \
  --exclude=./coverage \
  --exclude=./.dsh-build \
  --exclude=./benchmarks/.dsh-build \
  --exclude=./node_modules/.cache \
  .
[ -s "$ARTIFACT" ] || die "tar produced no artifact"
ARTIFACT_BYTES="$(stat -c %s "$ARTIFACT")"
log "artifact $(basename "$ARTIFACT"): $(bytes_human "$ARTIFACT_BYTES")"

step "2. Extraction smoke check"
if [ "$SMOKE" = "1" ]; then
  need curl
  rm -rf "$VERIFY_DIR"
  mkdir -p "$VERIFY_DIR"
  time tar --zstd -xf "$ARTIFACT" -C "$VERIFY_DIR"
  [ -f "$VERIFY_DIR/apps/cli/lib/bin.js" ] || die "extracted tree lacks apps/cli/lib/bin.js"
  [ -x "$VERIFY_DIR/$LAUNCHER_PATH" ] || die "extracted tree lacks executable $LAUNCHER_PATH: the launcher must be built before packing"
  need file
  file "$VERIFY_DIR/$LAUNCHER_PATH" | grep -q 'statically linked' || die "extracted $LAUNCHER_PATH is not a static ELF: $(file "$VERIFY_DIR/$LAUNCHER_PATH")"
  LAUNCHER_PROBE="$("$VERIFY_DIR/$LAUNCHER_PATH" --probe 2>&1)" || die "extracted landlock-run --probe failed: $LAUNCHER_PROBE"
  log "extracted landlock-run --probe: $LAUNCHER_PROBE"
  # The deployment target's kernel decides enforcement, not this build host.
  [ "$LAUNCHER_PROBE" = "landlock: fully enforced" ] || warn "this build host reports '$LAUNCHER_PROBE'; the extracted launcher is present but not fully enforced here"
  V="$(node "$VERIFY_DIR/apps/cli/lib/bin.js" --version 2>&1)" || die "extracted tree --version failed: $V"
  [ "$V" = "$VERSION" ] || die "extracted tree --version=$V != $VERSION"
  log "extracted --version = $V"
  TMP_HOME="$(mktemp -d "${TMPDIR:-/tmp}/dsh-smoke-home.XXXXXX")"
  SMOKE_PORT="${SMOKE_PORT:-5199}"
  node "$VERIFY_DIR/apps/cli/lib/bin.js" web --no-open --host 127.0.0.1 --port "$SMOKE_PORT" \
    >"$VERIFY_DIR/web-smoke.log" 2>&1 &
  SMOKE_PID=$!
  SMOKE_OK=0
  for _ in $(seq 1 90); do
    sleep 1
    CODE="$(curl -s -o /dev/null -m 2 -w '%{http_code}' "http://127.0.0.1:$SMOKE_PORT/" 2>/dev/null || echo 000)"
    if [ "$CODE" = "401" ]; then SMOKE_OK=1; break; fi
    kill -0 "$SMOKE_PID" 2>/dev/null || break
  done
  kill "$SMOKE_PID" 2>/dev/null || true
  wait "$SMOKE_PID" 2>/dev/null || true
  rm -rf "$TMP_HOME"
  if [ "$SMOKE_OK" != "1" ]; then
    sed -n '1,40p' "$VERIFY_DIR/web-smoke.log" | sed 's/^/         /'
    die "extracted tree failed the web smoke check (port $SMOKE_PORT did not answer 401)"
  fi
  log "extracted tree answered 401 on :$SMOKE_PORT"
  rm -rf "$VERIFY_DIR"
else
  warn "skipped the extraction smoke check (--skip-smoke)"
fi

step "3. Write sha256 and manifest"
ARTIFACT_SHA="$(sha256sum "$ARTIFACT" | awk '{print $1}')"
printf '%s\n' "$ARTIFACT_SHA" > "$ARTIFACT.sha256"
export MANIFEST_PATH="$MANIFEST" ARTIFACT_NAME="$(basename "$ARTIFACT")" \
  VERSION RELEASE_ID HEAD_SHA HEAD_SHORT ARTIFACT_SHA ARTIFACT_BYTES BUILT_ON \
  DIRTY_FILES="$(git status --porcelain | grep -v '^?? runs/' | grep -v '^?? artifacts/' | sed 's/^...//' | paste -sd, - 2>/dev/null || true)"
node --input-type=module -e '
import { writeFileSync } from "node:fs"
const env = process.env
const manifest = {
  schemaVersion: 1,
  version: env.VERSION,
  releaseId: env.RELEASE_ID,
  gitHead: env.HEAD_SHA,
  gitHeadShort: env.HEAD_SHORT,
  builtAt: new Date().toISOString(),
  builtOn: env.BUILT_ON,
  node: process.version,
  artifact: env.ARTIFACT_NAME,
  artifactSha256: env.ARTIFACT_SHA,
  artifactBytes: Number(env.ARTIFACT_BYTES),
  layout: "full-workspace-tree",
  installedEntry: "apps/cli/lib/bin.js",
  dirtyFiles: env.DIRTY_FILES ?? "",
  notes: "full workspace tree (sources + node_modules + built lib/dist); the target only extracts; entry apps/cli/lib/bin.js",
}
writeFileSync(env.MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
'
[ -s "$MANIFEST" ] || die "manifest was not written"

step "4. Done"
log "artifact: $ARTIFACT"
log "sha256:   $ARTIFACT_SHA"
log "manifest: $MANIFEST"
