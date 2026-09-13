/**
 * 开发/打包脚本：把 client.card.tsx 打成 dsh 客户端模块格式的 client.js。
 *
 * 运行：node build-card.mjs
 * 依赖：npm install -D esbuild react react-dom @types/react
 *
 * 产物是 window.__ModuleLoader__.load({ id, factory }) 格式的单文件，
 * 通过 package.json 的 dsh.client 声明被 dsh-client-modules 发现。
 */
import { build } from 'esbuild'
import { readFileSync, writeFileSync } from 'node:fs'

await build({
  entryPoints: ['client.card.tsx'],
  bundle: true,
  outfile: 'client.js',
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

const bundled = readFileSync('client.js', 'utf8')
writeFileSync('client.js', `window.__ModuleLoader__.load({
  id: "dsh-tdai-memory-plugin",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${bundled.split('\n').map((l) => '    ' + l).join('\n')}
    return module.exports;
  }
});
`)
console.log('built client.js')
