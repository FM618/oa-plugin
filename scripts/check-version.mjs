/**
 * 版本一致性检查：diagnostics.ts 里硬编码的 CLIENT_VERSION 必须与包版本一致。
 * 版本不一致会让「版本兼容」判断失真。
 */
import { readFile } from 'node:fs/promises'

const pkg = JSON.parse(await readFile('plugins/oa-runtime/package.json', 'utf8'))
const source = await readFile('plugins/oa-runtime/src/diagnostics.ts', 'utf8')
const match = source.match(/CLIENT_VERSION\s*=\s*'([^']+)'/)
if (!match) {
  console.error('✘ diagnostics.ts 里找不到 CLIENT_VERSION')
  process.exit(1)
}
if (match[1] !== pkg.version) {
  console.error(`✘ 版本不一致：package.json=${pkg.version}，CLIENT_VERSION=${match[1]}`)
  process.exit(1)
}
console.log(`✔ 版本一致：${pkg.version}`)
