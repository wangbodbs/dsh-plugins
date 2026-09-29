#!/bin/bash
# 把工作区里的自研插件源码同步进本发布仓库（本仓库是发布副本，开发仍在工作区）。
#
# 用法: bash scripts/sync-from-workspace.sh [工作区根目录]
#       默认工作区根目录 = $HOME/Downloads/DSH
#
# 只同步「源码」：lib/ tools/ cordis.patch.yml README.md
# **不同步**各包的 package.json 与 LICENSE —— 那两样是发布元数据，在本仓库里手工维护。
set -euo pipefail

WS="${1:-$HOME/Downloads/DSH}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"

[ -d "$WS" ] || { echo "❌ 找不到工作区: $WS" >&2; exit 1; }

sync_one () { # <源目录> <目标包名>
  local src="$1" dest="$REPO/packages/$2"
  [ -d "$src" ] || { echo "❌ 找不到源: $src" >&2; exit 1; }
  [ -d "$dest" ] || { echo "❌ 找不到目标: $dest" >&2; exit 1; }

  for d in lib tools; do
    [ -d "$src/$d" ] || continue
    rsync -a --delete "$src/$d/" "$dest/$d/"
  done
  rsync -a "$src/cordis.patch.yml" "$src/README.md" "$dest/"
  echo "  ✅ $2  ←  $src"
}

echo "=== 从 $WS 同步源码 ==="
sync_one "$WS/dsh-feishu"                          dsh-feishu
sync_one "$WS/dsh-mcp-bundles/dsh-mcp-flapi"       dsh-mcp-flapi
sync_one "$WS/dsh-mcp-bundles/dsh-mcp-davinci-resolve" dsh-mcp-davinci-resolve

echo
echo "=== 自检（各包 package.json 必须仍声明 dsh.bundle）==="
for p in "$REPO"/packages/*/; do
  name="$(basename "$p")"
  if node -e "const m=require('$p/package.json'); process.exit(m.dsh && m.dsh.bundle ? 0 : 1)"; then
    printf "  ✅ %-26s dsh.bundle 在\n" "$name"
  else
    printf "  ❌ %-26s 缺 dsh.bundle（会被 CI 拒）\n" "$name"
  fi
done

echo
echo "接下来: git add -A && git commit && git push"
