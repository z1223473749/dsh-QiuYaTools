import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {makeDomHarnessSource} from '../scripts/prepare-harness-dom-acceptance.mjs'
import {makeMacFullHarnessSource} from '../scripts/macos-full-harness-policy.mjs'
import {makeWindowsUIStateSource} from '../scripts/prepare-windows-ui-state-acceptance.mjs'
const original=await readFile(new URL('../scripts/e2e-harness.mjs',import.meta.url),'utf8')
const prompt="await editor().press('Tab'); assert.equal(await editor().innerText(), '继续检查本地测试结果。')\n    await screenshot('prompt-accepted')"
const menu="await menu(alpha); await page.getByRole('menuitem', { name: '取消置顶', exact: false }).waitFor(); await screenshot('session-menu-pin'); await page.keyboard.press('Escape')"
for(const[name,transform]of[
 ['DOM',source=>makeDomHarnessSource(source,{repository:'/unit/repo/',providerSource:'/unit/provider.mjs'})],
 ['Mac full12',source=>makeMacFullHarnessSource(source,{repository:'/unit/repo/',snapshot:'/unit/snapshot/',policySource:'/unit/policy.mjs'})],
 ['Windows UI',makeWindowsUIStateSource],
])test(name+' consumes existing shared screenshots exactly once and still rejects missing or duplicated full anchors',()=>{
 const result=transform(original)
 for(const shot of['prompt-accepted','session-menu-pin'])assert.equal(result.split("await screenshot('"+shot+"')").length,2)
 for(const action of["await editor().press('Tab')","await page.keyboard.press('Escape')"])assert.equal(result.split(action).length,original.split(action).length)
 for(const anchor of[prompt,menu]){
  assert.equal(original.split(anchor).length,2)
  assert.throws(()=>transform(original.replace(anchor,anchor.replace('await screenshot','await changedScreenshot'))),/Unique .*anchor/u)
  assert.throws(()=>transform(original+'\n'+anchor),/Unique .*anchor/u)
 }
})
