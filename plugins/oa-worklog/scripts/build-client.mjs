/**
 * client 半部构建：esbuild 打成单文件 CJS，再包成 DSH 模块注册协议。
 * 平台静态模块表之外的依赖一律打进产物。
 */
import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** DSH Web 平台静态模块表（这些只能 require，不能打包） */
const RUNTIME_EXTERNALS = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

const pkg = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(pkgRoot, 'package.json'), 'utf8'))

const result = await build({
  entryPoints: [path.join(pkgRoot, 'src-client', 'index.jsx')],
  bundle: true, write: false, format: 'cjs', platform: 'browser', target: 'es2022',
  jsx: 'automatic', external: RUNTIME_EXTERNALS, charset: 'utf8', logLevel: 'info',
})

const indented = result.outputFiles[0].text.trimEnd().replace(/^/gm, '    ')
const wrapped = `/** ${pkg.name} — client 半部（构建产物，勿手改） */
window.__ModuleLoader__.load({
  id: ${JSON.stringify(pkg.name)},
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
${indented}
    return module.exports
  },
})
`
const outFile = path.join(pkgRoot, 'lib', 'client.js')
await mkdir(path.dirname(outFile), { recursive: true })
await writeFile(outFile, wrapped, 'utf8')
console.log(`[${pkg.name}] ${path.relative(pkgRoot, outFile)} 已生成（${(wrapped.length / 1024).toFixed(1)} KB）`)
