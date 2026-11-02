import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
const source=(await build({entryPoints:['src/features/computer-use/contract.ts'],bundle:true,write:false,platform:'node',format:'esm'})).outputFiles[0].text
const {parseComputerAction}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
test('bounded key and click holds survive action validation without changing text semantics',()=>{
 for(const holdMs of [1,50,2000]) assert.equal(parseComputerAction({kind:'key',key:'Ctrl+Left',holdMs,inputMode:'compatibility'}).holdMs,holdMs)
 assert.equal(parseComputerAction({kind:'click',x:2,y:3,holdMs:200}).holdMs,200)
 for(const holdMs of [0,-1,2001,1.5,'50',Infinity]) assert.throws(()=>parseComputerAction({kind:'key',key:'A',holdMs}),{code:'INVALID_ACTION'})
 for(const kind of ['type','move','scroll']) assert.throws(()=>parseComputerAction({kind,text:'x',x:1,y:1,deltaY:1,holdMs:50}),{code:'INVALID_ACTION'})
})
test('relative movement is explicit, bounded and cannot carry conflicting absolute coordinates',()=>{
 assert.deepEqual(parseComputerAction({kind:'moveRelative',deltaX:-12,deltaY:8}),{kind:'moveRelative',deltaX:-12,deltaY:8})
 for(const action of [{},{deltaX:0,deltaY:0},{deltaX:0.5},{deltaX:4097},{deltaY:-4097},{deltaX:2,x:10},{deltaY:2,toY:1}]) assert.throws(()=>parseComputerAction({kind:'moveRelative',...action}),{code:'INVALID_ACTION'})
})
test('delivery mode cannot smuggle private native options or an unsupported operation',()=>{
 assert.equal(parseComputerAction({kind:'type',text:'测试',inputMode:'compatibility'}).text,'测试')
 for(const action of [{kind:'key',key:'A',inputMode:'arbitrary'},{kind:'click',x:1,y:1,inputMode:'compatibility'},{kind:'key',key:'A',scanCode:30}]) assert.throws(()=>parseComputerAction(action),{code:'INVALID_ACTION'})
})
