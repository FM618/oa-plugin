/**
 * 静态检查：client 半部里 `styles.xxx` 的引用必须都有定义。
 *
 * 这类漏定义不会报错，只会静默丢失样式（例如按钮退回浏览器默认外观），
 * 所以单独做成一步检查。
 */
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const roots = ['packages', 'plugins']
let failed = false

for (const root of roots) {
  const names = await readdir(root).catch(() => [])
  for (const name of names) {
    const file = path.join(root, name, 'src-client', 'index.jsx')
    let source
    try {
      source = await readFile(file, 'utf8')
    } catch {
      continue
    }
    const used = new Set([...source.matchAll(/styles\.([A-Za-z0-9_]+)/g)].map((m) => m[1]))
    const start = source.indexOf('const styles = {')
    if (start === -1) continue
    const block = source.slice(start)
    const defined = new Set([...block.matchAll(/^ {2}([A-Za-z0-9_]+):/gm)].map((m) => m[1]))
    const missing = [...used].filter((key) => !defined.has(key))
    const unused = [...defined].filter((key) => !used.has(key))
    if (missing.length) {
      failed = true
      console.error(`✘ ${file} 使用了未定义的样式：${missing.join(', ')}`)
    } else {
      console.log(`✔ ${file} 样式键完整${unused.length ? `（未使用：${unused.join(', ')}）` : ''}`)
    }
  }
}

process.exit(failed ? 1 : 0)
