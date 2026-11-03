/**
 * 开发/打包脚本：把 client.card.tsx 打成 dsh 客户端模块格式的 client.js。
 *
 * 运行：node build-card.mjs
 * 依赖：npm install -D esbuild react react-dom @types/react
 *
 * 产物是 window.__ModuleLoader__.load({ id, factory }) 格式的单文件，
 * 通过 package.json 的 dsh.client 声明被 dsh-client-modules 发现。
 *
 * `buildCardText()` 也供测试直接用：`test/settings-card.test.mjs` 拿它和已提交的
 * client.js 做**逐字节**比对 —— 只 grep label 的旧口径漏得掉"改了逻辑但没改文案"的
 * 陈旧产物。
 */
import { build } from 'esbuild'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** 当前 client.card.tsx 的完整产物文本（= 应写到 client.js 的内容）。 */
export async function buildCardText({ entry = join(here, 'client.card.tsx') } = {}) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    // 写内存：测试只要文本，脚本自己落盘，避免测试中途覆盖工作区文件
    write: false,
    format: 'cjs',
    platform: 'browser',
    jsx: 'automatic',
    external: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-store',
      '@deepseek-ai/dsh-client-ui-slots',
      // react / jsx-runtime 必须 external：由 shell 提供同一份实例，
      // 否则 bundle 内嵌第二份 React，hooks 与 slot 渲染的 React 实例不匹配直接崩溃。
      'react',
      'react/jsx-runtime',
    ],
    define: { 'process.env.NODE_ENV': '"production"' },
    minify: true,
    sourcemap: false,
  })
  const bundled = result.outputFiles[0].text
  return `window.__ModuleLoader__.load({
  id: "dsh-tdai-memory-plugin",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${bundled.split('\n').map((l) => '    ' + l).join('\n')}
    return module.exports;
  }
});
`
}

// 只有直接运行时才落盘（被测试 import 时不动工作区文件）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(join(here, 'client.js'), await buildCardText())
  console.log('built client.js')
}
