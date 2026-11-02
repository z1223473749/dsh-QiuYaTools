import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { renderToStaticMarkup } from 'react-dom/server'
import React from 'react'
const require = createRequire(import.meta.url)
const source = (await build({entryPoints:['src/features/computer-use/presentation.tsx'],bundle:true,write:false,platform:'node',format:'cjs',packages:'external'})).outputFiles[0].text
const module = {exports:{}}
new Function('require','module','exports',source)(require,module,module.exports)
const {SystemPermissionNotice} = module.exports
const render = native => renderToStaticMarkup(React.createElement(SystemPermissionNotice,{native,busy:false,onOpenSettings(){},onRefresh(){}}))
test('ordinary Windows exposes an owner action without claiming administrator access',()=>{
 const html=render({platform:'win32',available:true,permissions:{administrator:false}})
 assert.match(html,/启用管理员访问/);assert.match(html,/停止当前控制/);assert.doesNotMatch(html,/管理员应用控制已启用/)
})
test('confirmed elevated Windows does not offer a second prompt',()=>{
 const html=render({platform:'win32',available:true,permissions:{administrator:true}})
 assert.match(html,/管理员应用控制已启用/);assert.doesNotMatch(html,/<button/)
})
test('browser control never requests administrator access',()=>{
 assert.doesNotMatch(render({platform:'win32',mode:'browser',available:true}),/管理员访问/)
})
