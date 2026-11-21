#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$ROOT_DIR"
# 一律用相对路径喂给 node：CI 的 Windows 作业跑在 Git Bash 里，$ROOT_DIR 是 /d/a/... 这种
# MSYS 路径，Windows 版 node 解析不了；而 node 继承的工作目录本来就是这里。
PLUGIN_DIR=utools   # 打包目录，不含 .git

command -v node >/dev/null || { echo "error: Node.js is required" >&2; exit 1; }
command -v pnpm >/dev/null || { echo "error: pnpm is required (corepack enable)" >&2; exit 1; }

# 版本只卡下限，不卡死某一个版本：低于 12 必须拦住（lockfile 为 pnpm 12 格式）。
PNPM_VERSION=$(pnpm --version)
PNPM_MAJOR=${PNPM_VERSION%%.*}
if ! [ "$PNPM_MAJOR" -ge 12 ] 2>/dev/null; then
  echo "error: pnpm >= 12 is required, found $PNPM_VERSION" >&2
  echo "       run: corepack enable  (then pnpm follows package.json#packageManager)" >&2
  exit 1
fi

# Node 的下限只写在 package.json#engines.node 一处，这里读它来卡 —— 原来这个脚本一个
# 版本检查都没有，而测试用的 jsdom 30 自己要求 22.22.2+，版本不够的表现是所有 jsdom
# 环境的测试文件一加载就炸（markAsUncloneable is not a function），看不出是 Node 的事。
node -e '
const want = (require("./package.json").engines || {}).node || "";
const match = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(want.trim());
if (!match) {
  console.error(`error: package.json#engines.node 是「${want}」，本脚本只认 >=x.y.z 这种写法`);
  process.exit(2);
}
const need = match.slice(1).map(Number);
const have = process.versions.node.split(".").map(Number);
const diff = need.map((n, i) => have[i] - n).find((d) => d !== 0) || 0;
if (diff < 0) {
  console.error(`error: Node ${want} is required, found ${process.versions.node}`);
  process.exit(1);
}
'

echo "=== install dependencies ==="
pnpm install --frozen-lockfile

if [ "${SKIP_CHECKS:-0}" = "1" ]; then
  echo "SKIP_CHECKS=1: 跳过 lint / typecheck / test"
else
  echo "=== check source ==="
  pnpm lint
  pnpm typecheck

  echo "=== test source ==="
  pnpm test
fi

node --check "$PLUGIN_DIR/preload.js"
node -e "const plugin = JSON.parse(require('fs').readFileSync('$PLUGIN_DIR/plugin.json', 'utf8')); if (plugin.version !== require('./package.json').version) throw new Error('Version mismatch')"

echo "=== build Vue application ==="
rm -rf -- "$PLUGIN_DIR/dist"
pnpm build

echo "=== verify artifacts ==="
test -f "$PLUGIN_DIR/dist/index.html"
test -f "$PLUGIN_DIR/preload.js"
test -f "$PLUGIN_DIR/logo.png"
test -f "$PLUGIN_DIR/search.png"
test ! -e "$PLUGIN_DIR/.git" || { echo "error: utools/ 内不应存在 .git" >&2; exit 1; }

echo "uTools plugin ready: $PLUGIN_DIR/plugin.json"
