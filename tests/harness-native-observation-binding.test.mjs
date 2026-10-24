import test from 'node:test'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {realpathSync} from 'node:fs'
import {observationMetadataDecoder,trackOriginalNativeObservations} from './fixtures/harness-native-observation-binding.mjs'

const expected={'$.requestId':17,'$.ok':true,'$.result.targetId':'mac-window:11','$.result.frameId':'frame-17'}
function decode(text,size=13,options){const rows=[],reader=observationMetadataDecoder(row=>rows.push(row),options);const bytes=Buffer.from(text);for(let at=0;at<bytes.length;at+=size)reader.push(bytes.subarray(at,at+size));return {rows,reader}}
test('arbitrary native JSON property order retains only receipt metadata after a large image/AX body',()=>{
 const image='z'.repeat(1024*1024),value={result:{imageBase64:image,elements:[{name:'SECRET TEXT',value:null,children:['escaped\\"text',true,42]}],frameId:'frame-17',targetId:'mac-window:11'},ok:true,requestId:17}
 const {rows,reader}=decode(JSON.stringify(value)+'\n',317)
 assert.deepEqual(rows,[expected]);assert(reader.maximumRetainedBytes<100);assert(!JSON.stringify(rows).includes('SECRET'));assert.equal(reader.incomplete,false)
})
test('metadata string escapes and arbitrary byte splits are decoded without matching embedded fake keys',()=>{
 const text='{"result":{"elements":["\\\"frameId\\\":\\\"fake\\\""],"targetId":"mac-window:11","frameId":"frame-\\u0031\\u0037"},"requestId":17,"ok":true}\n'
 assert.deepEqual(decode(text,1).rows,[expected])
})
for(const [name,text] of Object.entries({duplicate:'{"requestId":17,"requestId":18}\n',duplicateResult:'{"result":{},"result":{}}\n',trailingComma:'{"result":{"frameId":"frame"},}\n',badEscape:'{"secret":"\\q"}\n',truncated:'{"secret":"text\n',wrongClosing:'{"x":[1,2}}\n'}))test('malformed '+name+' fails before a receipt can be selected',()=>assert.throws(()=>decode(text,1),e=>e.code==='SOURCE_WIRE_INVALID'))
test('response line size is bounded without retaining oversized image contents',()=>assert.throws(()=>decode('{"image":"'+'x'.repeat(1000)+'"}\n',71,{maxLineBytes:128}),e=>e.code==='SOURCE_WIRE_INVALID'))
test('incomplete tail is not a complete original receipt',()=>{const {rows,reader}=decode('{"requestId":17}',2);assert.equal(rows.length,0);assert(reader.incomplete)})
test('oversized metadata/key cannot allocate unbounded retained text',()=>{assert.throws(()=>decode('{"result":{"frameId":"'+'x'.repeat(2000)+'"}}\n'),e=>e.code==='SOURCE_WIRE_INVALID');assert.throws(()=>decode('{"'+'x'.repeat(132)+'":null}\n'),e=>e.code==='SOURCE_WIRE_INVALID')})

const childSource=`import readline from 'node:readline';process.stdout.write('{"event":"ready"}\\n');const input=readline.createInterface({input:process.stdin});for await(const line of input){const request=JSON.parse(line);if(request.op==='observe')process.stdout.write(JSON.stringify({result:{imageBase64:'z'.repeat(request.imageBytes??0),elements:[{name:'SECRET OWN FIXTURE ONLY'}],frameId:request.replyFrame??('frame-'+request.requestId),targetId:request.replyTarget??request.targetId},ok:request.ok!==false,requestId:request.replyRequest??request.requestId})+'\\n');else process.stdout.write(JSON.stringify({ack:request.op})+'\\n')}`
async function fixture(work,{maximumChildren=16}={}){
 const inspected=[],tracker=trackOriginalNativeObservations({maximumChildren,inspectCandidate(child){inspected.push(child);return {executablePath:realpathSync(child.spawnfile),sha256:'own-node-test-only'}}}),children=[]
 const create=async()=>{const child=spawn(process.execPath,['--input-type=module','-e',childSource],{stdio:['pipe','pipe','pipe']});children.push(child);child.stderr.resume();child.stdout.setEncoding('utf8');let carry='';const rows=[];child.stdout.on('data',data=>{carry+=data;let at;while((at=carry.indexOf('\n'))>=0){rows.push(JSON.parse(carry.slice(0,at)));carry=carry.slice(at+1)}});await once(child,'spawn');await until(()=>rows.some(r=>r.event==='ready'));return {child,rows}}
 try{await work({tracker,create,inspected})}finally{tracker.dispose();for(const child of children){const exit=once(child,'exit');child.stdin.end();const [code,signal]=await exit;assert.equal(code,0);assert.equal(signal,null)}}
}
async function until(predicate){const deadline=performance.now()+1500;while(!predicate()){if(performance.now()>deadline)throw Error('Own Node fixture bounded wait failed');await new Promise(resolve=>setTimeout(resolve,2))}}
async function request(value,row){value.child.stdin.write(JSON.stringify(row)+'\n');await until(()=>value.rows.some(r=>r.requestId===(row.replyRequest??row.requestId)))}
test('actual public construction event binds at spawn; two equal executables select the original request/frame child, not first',()=>fixture(async({tracker,create,inspected})=>{
 const a=await create(),b=await create();assert.equal(inspected.length,2)
 await request(a,{requestId:1,op:'observe',targetId:'mac-window:1',preview:true})
 await request(b,{requestId:6,op:'observe',targetId:'mac-window:11',imageBytes:100000})
 const selected=tracker.select({targetId:'mac-window:11',frameId:'frame-6'});assert.equal(selected.child,b.child);assert.deepEqual(selected.receipt,{requestId:6,targetId:'mac-window:11',frameId:'frame-6'})
 assert.throws(()=>tracker.select({targetId:'mac-window:1',frameId:'frame-1'}),e=>e.code==='SOURCE_WIRE_RECEIPT_MISSING')
 assert.equal(a.rows.length,2);assert.equal(b.rows.length,2) // Original ready + original request only, no tracker RPC.
}))
test('same exact receipt in two actual children is ambiguous and never guessed',()=>fixture(async({tracker,create})=>{for(let i=0;i<2;i++)await request(await create(),{requestId:6,op:'observe',targetId:'mac-window:11'});assert.throws(()=>tracker.select({targetId:'mac-window:11',frameId:'frame-6'}),e=>e.code==='SOURCE_WIRE_RECEIPT_AMBIGUOUS')}))
test('a different request ID response cannot satisfy the original observation',()=>fixture(async({tracker,create})=>{await request(await create(),{requestId:6,replyRequest:7,op:'observe',targetId:'mac-window:11'});assert.throws(()=>tracker.select({targetId:'mac-window:11',frameId:'frame-6'}),e=>e.code==='SOURCE_WIRE_RECEIPT_MISSING')}))
test('response target mismatch permanently fails closed rather than falling back to another child',()=>fixture(async({tracker,create})=>{await request(await create(),{requestId:6,op:'observe',targetId:'mac-window:11',replyTarget:'mac-window:12'});assert.throws(()=>tracker.select({targetId:'mac-window:11',frameId:'frame-6'}),e=>e.code==='SOURCE_WIRE_RESPONSE_INVALID')}))
test('non-ASCII requested frame cannot be silently bound through a byte/string decoding approximation',()=>fixture(async({tracker,create})=>{await request(await create(),{requestId:6,op:'observe',targetId:'mac-window:11',replyFrame:'frame-中文'});assert.throws(()=>tracker.select({targetId:'mac-window:11',frameId:'frame-中文'}),e=>e.code==='SOURCE_WIRE_RECEIPT_MISSING')}))
test('native error receipt is not an observation',()=>fixture(async({tracker,create})=>{await request(await create(),{requestId:6,op:'observe',targetId:'mac-window:11',ok:false});assert.throws(()=>tracker.select({targetId:'mac-window:11',frameId:'frame-6'}),e=>e.code==='SOURCE_WIRE_RESPONSE_INVALID')}))
test('an unrelated legitimate legacy worker failure cannot impersonate or veto the exact chat observation',()=>fixture(async({tracker,create})=>{const legacy=await create(),chat=await create();await request(legacy,{requestId:5,op:'observe',targetId:'mac-window:12',ok:false});await request(chat,{requestId:6,op:'observe',targetId:'mac-window:11'});assert.equal(tracker.select({targetId:'mac-window:11',frameId:'frame-6'}).child,chat.child)}))
test('tracking count overflow fails without closing or signalling either actual own child',()=>fixture(async({tracker,create})=>{const a=await create(),b=await create();await request(a,{requestId:6,op:'observe',targetId:'mac-window:11'});assert.throws(()=>tracker.select({targetId:'mac-window:11',frameId:'frame-6'}),e=>e.code==='SOURCE_SPAWN_TRACKING_LIMIT');assert.equal(a.child.exitCode,null);assert.equal(b.child.exitCode,null)},{maximumChildren:1}))
test('dispose restores original stream write and leaves process/consumer open and functional',()=>fixture(async({tracker,create})=>{const value=await create(),wrapped=value.child.stdin.write,beforeListeners=value.child.stdout.listenerCount('data');tracker.dispose();assert.notEqual(value.child.stdin.write,wrapped);assert.equal(value.child.stdout.listenerCount('data'),beforeListeners-1);await request(value,{requestId:6,op:'observe',targetId:'mac-window:11'});assert.equal(value.child.exitCode,null);assert.throws(()=>tracker.select({targetId:'mac-window:11',frameId:'frame-6'}),e=>e.code==='SOURCE_WIRE_CLOSED')}))
