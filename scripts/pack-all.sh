#!/usr/bin/env bash
# 把三个包打成 tgz，统一放到 oa-plugin/dist/
# 用法：pnpm pack   （或 ./scripts/pack-all.sh）
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

# 打包前先构建，避免分发旧产物
pnpm -r build >/dev/null

rm -rf "$ROOT/dist"
mkdir -p "$ROOT/dist"

for pkg in packages/plugin-kit plugins/oa-runtime plugins/oa-worklog plugins/oa-bundle; do
  ( cd "$pkg" && pnpm pack --pack-destination "$ROOT/dist" >/dev/null )
done

echo "已生成："
ls -lh "$ROOT/dist" | tail -n +2 | awk '{print "  " $5 "\t" $9}'
