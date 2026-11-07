#!/usr/bin/env bash
# 把三个插件包打成 tgz，统一放到 oa-plugin/dist/
# 用法：pnpm run pack   （或 ./scripts/pack-all.sh）
#
# 规则（D-082）：
# - 每次打包**只新增**当前版本的 tgz，历史版本的包一律保留，所有版本共存；
# - 同一版本号不重复打包：目标文件已存在就报错退出（内容变了就升版本，见 D-081）。
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

# 打包前先构建，避免分发旧产物
pnpm -r build >/dev/null

mkdir -p "$ROOT/dist"

created=0
for pkg in plugins/oa-runtime plugins/oa-worklog plugins/oa-bundle; do
  (
    cd "$pkg"
    read -r name version <<<"$(node -e "
      const pkg = JSON.parse(require('fs').readFileSync('package.json', 'utf8'))
      process.stdout.write(pkg.name + ' ' + pkg.version)
    ")"
    # @fm618/oa-runtime → fm618-oa-runtime（与 pnpm pack 的命名一致）
    slug=$(printf '%s' "$name" | sed 's#^@##; s#/#-#g')
    target="$ROOT/dist/${slug}-${version}.tgz"
    if [ -e "$target" ]; then
      echo "✘ ${slug}-${version}.tgz 已存在：同一版本号不重复打包，请先升版本（见 D-081 / D-082）" >&2
      exit 1
    fi
    pnpm pack --pack-destination "$ROOT/dist" >/dev/null
    echo "  + $(basename "$target")"
  ) || exit 1
  created=$((created + 1))
done

echo
echo "dist/ 现有 ${created} 个新包，历史版本保持不变："
ls -1 "$ROOT/dist" | sed 's/^/  /'
