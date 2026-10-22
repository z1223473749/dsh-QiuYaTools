import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { visionOwnerSettingsSnapshot, projectVisionOwnerRPC } from '../scripts/live-vision-owner-evidence.mjs'
import { createVisionLocalOwnerFetch } from '../scripts/live-vision-host-autorun.mjs'
import { projectVisionFailure } from '../scripts/live-vision-guard-core.mjs'
const ownRow={ns:'qiuya-tools',revision:7,applies:'live',user:{enabled:false},value:{enabled:false,computerUseEnabled:false}},sessionIds=[1,2,3].map(()=>`qiuya-vision-${randomUUID()}`)
const modulePromise=build({entryPoints:[fileURLToPath(new URL('../scripts/live-vision-guard-plugin.mjs',import.meta.url))],bundle:true,write:false,platform:'node',format:'esm'}).then(r=>import('data:text/javascript;base64,'+Buffer.from(r.outputFiles[0].contents).toString('base64')))
test('owner snapshot publishes only two booleans/presence and finite namespace metadata, never schema or other namespaces',()=>{
 const result=visionOwnerSettingsSnapshot({writable:true,namespaces:[{ns:'private-account',value:'PRIVATE'}, {...ownRow,schema:'PRIVATE_SCHEMA',user:{...ownRow.user,apiKey:'PRIVATE_KEY'},value:{...ownRow.value,unrelated:'PRIVATE'}}]})
 assert.equal(result.namespaceMatchCount,1);assert.equal(result.namespaceWritable,null);assert.equal(result.revision,7);assert.equal(result.revisionKind,'integer');assert.equal(result.revisionNull,false);assert.equal(result.fields.length,2)
 assert.deepEqual(result.fields[0],{key:'enabled',own:true,raw:false,present:true,effectiveBoolean:true,effective:false});assert.equal(result.fields[1].own,false)
 assert.doesNotMatch(JSON.stringify(result),/PRIVATE|apiKey|schema|private-account|unrelated/u)
 const duplicate=visionOwnerSettingsSnapshot({writable:true,namespaces:[ownRow,ownRow]});assert.equal(duplicate.namespaceMatchCount,2);assert.equal(duplicate.present,false);assert.equal(duplicate.revision,null)
 const missing=visionOwnerSettingsSnapshot({namespaces:[]});assert.equal(missing.namespaceMatchCount,0);assert.equal(missing.present,false)
 const nullable=visionOwnerSettingsSnapshot({...ownRow,revision:null,writable:false});assert.equal(nullable.revisionNull,true);assert.equal(nullable.namespaceWritable,false)
})
test('owner RPC keeps known settings/gateway code and phase, hashes unknown errors, and never retains arguments or messages',()=>{
 const result=projectVisionOwnerRPC({method:'settings/mutate',phase:'owner-enable',requestRpcId:'own',response:{ok:true,status:200},value:{rpcId:'own',result:{ok:false,error:{code:'settings/rejected',message:'PRIVATE_ACCOUNT_AND_PATH',data:{private:'PRIVATE'}}}}})
 assert.equal(result.errorCode,'settings/rejected');assert.equal(result.phase,'owner-enable');assert.equal(result.rpcIdMatches,true);assert.equal(result.remoteOK,false);assert.match(result.errorMessageSHA,/^[a-f0-9]{64}$/u);assert.doesNotMatch(JSON.stringify(result),/PRIVATE|data|arguments/u)
 assert.equal(projectVisionFailure({code:'gateway/arguments-invalid'},'owner-restore-flags').code,'gateway/arguments-invalid')
 const unknown=projectVisionOwnerRPC({method:'settings/mutate',phase:'PRIVATE_PHASE',error:{code:'PRIVATE_CODE',message:'PRIVATE_MESSAGE'}});assert.equal(unknown.phase,'unknown');assert.equal(unknown.errorCode,null);assert.match(unknown.unknownCodeSHA,/^[a-f0-9]{64}$/u);assert.doesNotMatch(JSON.stringify(unknown),/PRIVATE/u)
})
function fakeHost({rows=[ownRow],probeOnly=false,rejectMutation=false,changeOnRejectedEnable=false,nativeMode,prepareError=false,acceptMutation=false,onCall=()=>{}}={}){
 rows=structuredClone(rows);const base=structuredClone(rows[0]?.value??{});let mutationCount=0
 const calls=[],evidence=[],peer={principal:{kind:'owner'},signal:new AbortController().signal},ctx={connection:{browserPeer:peer,createSharedFetchHandler(){return{async fetch(request,actual){assert.equal(actual,peer);const body=await request.json();calls.push(body);onCall(body,rows);if(body.op){if(body.op==='prepare'&&prepareError)return Response.json({ok:false,error:'VISION_EXTERNAL_CONFIG',diagnostic:{phase:'external-wait'}});return Response.json({ok:true,value:body.op==='cancel-run'?{requested:true,confirmed:true,status:'cancelled'}:{passed:false}})};let value;if(body.method==='settings/describe')value={writable:true,namespaces:rows};else if(body.method==='settings/mutate'){if(rejectMutation){if(changeOnRejectedEnable&&++mutationCount===1){rows[0].user={enabled:true,computerUseEnabled:true};rows[0].value={enabled:true,computerUseEnabled:true}}return Response.json({rpcId:body.rpcId,result:{ok:false,error:{code:'settings/rejected',message:'PRIVATE_REJECTION'}}})};if(!acceptMutation)assert.fail('Read-only test must not mutate');assert.equal(body.payload.args.expectedRevision,rows[0].revision);if(acceptMutation!=='ack-only'){for(const op of body.payload.args.ops){const key=op.path[0];if(op.op==='set'){rows[0].user[key]=op.value;rows[0].value[key]=op.value}else{delete rows[0].user[key];rows[0].value[key]=base[key]}}rows[0].revision++};value=rows[0]}
 else if(body.method==='qiuya-tools.computer.control'){assert.equal(body.payload.op,'status');value={enabled:nativeMode==='local',switching:false,native:nativeMode?{mode:nativeMode}:null,sessions:[]}}
 else assert.fail('No prompt/session/other API is allowed');return Response.json({rpcId:body.rpcId,result:{ok:true,value}})}}}}}
 return{calls,evidence,fetch:createVisionLocalOwnerFetch(ctx,sessionIds,{probeOnly,onDiagnostic:async value=>evidence.push(value)})}
}
test('the actual shared runner probe reads unique metadata and proves unchanged flags/connection without mutation/model or PD preparation',async()=>{
 const {runVisionAcceptanceWithFetch}=await modulePromise,host=fakeHost({probeOnly:true}),result=await runVisionAcceptanceWithFetch(host.fetch,()=>{},{probeOnly:true})
 assert.equal(result.kind,'QIUYA_READ_ONLY_OWNER_PROBE');assert.equal(result.probePassed,true);assert.equal(result.passed,false);assert.equal(result.modelInferenceRequested,false);assert.equal(result.settingsMutationRequested,false);assert.equal(result.connectionDispatches,0);assert.deepEqual(result.restoration,{localMode:true,featureFlags:true});assert.deepEqual(result.tasks,[])
 assert.ok(host.calls.every(x=>x.method==='settings/describe'||x.method==='qiuya-tools.computer.control'&&x.payload.op==='status'))
 assert.ok(host.evidence.some(x=>x.rpc.settings?.namespaceMatchCount===1));assert.doesNotMatch(JSON.stringify(host.evidence),/PRIVATE/u)
})
test('probe adapter independently refuses mutation, preparation, prompt and connect even if a caller tries them',async()=>{
 const host=fakeHost({probeOnly:true}),envelope=(method,args)=>({method:'POST',body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method,payload:method==='qiuya-tools.computer.control'?args:{args}})})
 await assert.rejects(host.fetch('/api/settings/mutate',envelope('settings/mutate',{ns:'qiuya-tools',expectedRevision:7,ops:[{op:'set',path:['enabled'],value:true}]})),{code:'VISION_AUTORUN_SCOPE'})
 await assert.rejects(host.fetch('/api/qiuya-tools.vision-test',{method:'POST',body:JSON.stringify({op:'prepare',task:1})}),{code:'VISION_AUTORUN_SCOPE'});assert.equal(host.calls.length,0)
})
test('a true settings rejection is retained with original phase; no model is sent and finally diagnostics distinguish restore from enable',async()=>{
 const {runVisionAcceptanceWithFetch}=await modulePromise,host=fakeHost({rejectMutation:true,changeOnRejectedEnable:true}),result=await runVisionAcceptanceWithFetch(host.fetch,()=>{})
 assert.equal(result.passed,false);assert.equal(result.error,'settings/rejected');assert.equal(result.diagnostic.phase,'owner-enable');assert.deepEqual(result.tasks,[]);assert.equal(result.connectionDispatches,0)
 const failed=host.evidence.filter(x=>x.rpc.errorCode==='settings/rejected');assert.deepEqual(failed.map(x=>x.rpc.phase),['owner-enable']);assert.equal(host.calls.filter(x=>x.method==='settings/mutate').length,1);assert.equal(result.restoration.featureFlags,false);assert.equal(result.restoration.localMode,true)
 assert.doesNotMatch(JSON.stringify(host.evidence),/PRIVATE_REJECTION/u)
})
test('duplicate namespace, absent field, wrong revision type or per-row read-only state fails before mutation or model',async()=>{
 const {runVisionAcceptanceWithFetch}=await modulePromise
 for(const rows of [[ownRow,ownRow],[{...ownRow,value:{enabled:true}}],[{...ownRow,revision:'7'}],[{...ownRow,writable:false}]]){const host=fakeHost({rows,probeOnly:true}),result=await runVisionAcceptanceWithFetch(host.fetch,()=>{},{probeOnly:true});assert.equal(result.probePassed,false);assert.equal(result.error,'VISION_SETTINGS_SNAPSHOT_INVALID');assert.ok(host.calls.every(x=>x.op==='failure'||x.method==='settings/describe'))}
})
test('an unconfirmed dispatched mutation cannot be declared restored from coincidentally unchanged values or replayed',async()=>{
 const {runVisionAcceptanceWithFetch}=await modulePromise,host=fakeHost({rejectMutation:true}),result=await runVisionAcceptanceWithFetch(host.fetch,()=>{})
 assert.equal(result.passed,false);assert.equal(result.error,'settings/rejected');assert.equal(result.enableProof,'unconfirmed');assert.equal(result.restoration.featureFlags,false);assert.equal(result.restorationProof.featureFlags,'unconfirmed');assert.equal(host.calls.filter(x=>x.method==='settings/mutate').length,1);assert.equal(result.tasks.length,0)
})
test('already-enabled flags enter the real preparation path without any settings mutation',async()=>{
 const {runVisionAcceptanceWithFetch}=await modulePromise,host=fakeHost({rows:[{...ownRow,user:{enabled:true,computerUseEnabled:true},value:{enabled:true,computerUseEnabled:true}}],nativeMode:'local',prepareError:true}),result=await runVisionAcceptanceWithFetch(host.fetch,()=>{})
 assert.equal(result.enableProof,'already-enabled-readback');assert.equal(host.calls.some(x=>x.op==='prepare'),true);assert.equal(host.calls.some(x=>x.method==='settings/mutate'),false);assert.equal(result.error,'VISION_EXTERNAL_CONFIG');assert.equal(result.restoration.featureFlags,true);assert.equal(result.restorationProof.featureFlags,'unchanged-readback')
})
test('only false fields get one revision-fenced enable write and a confirmed readback before preparation',async()=>{
 const {runVisionAcceptanceWithFetch}=await modulePromise,host=fakeHost({rows:[{...ownRow,user:{enabled:true},value:{enabled:true,computerUseEnabled:false}}],nativeMode:'local',prepareError:true,acceptMutation:true}),result=await runVisionAcceptanceWithFetch(host.fetch,()=>{})
 assert.equal(result.enableProof,'cas-confirmed-readback');const writes=host.calls.filter(x=>x.method==='settings/mutate');assert.equal(writes[0].payload.args.expectedRevision,7);assert.deepEqual(writes[0].payload.args.ops,[{op:'set',path:['computerUseEnabled'],value:true}]);assert.equal(writes.length,2);assert.equal(host.calls.some(x=>x.op==='prepare'),true);assert.equal(result.restoration.featureFlags,true);assert.equal(result.restorationProof.featureFlags,'restored-readback')
 assert.equal(writes[1].payload.args.expectedRevision,8);assert.deepEqual(writes[1].payload.args.ops,[{op:'unset',path:['computerUseEnabled']}])
})
test('a successful mutate response without true effective readback cannot start a fixture or model and cancels once',async()=>{
 const {runVisionAcceptanceWithFetch}=await modulePromise,host=fakeHost({nativeMode:'local',acceptMutation:'ack-only'}),result=await runVisionAcceptanceWithFetch(host.fetch,()=>{})
 assert.equal(result.error,'VISION_FEATURE_ENABLE_UNCONFIRMED');assert.equal(result.enableProof,'unconfirmed');assert.equal(host.calls.some(x=>x.op==='prepare'),false);assert.equal(host.calls.some(x=>x.method==='session/prompt'),false);assert.equal(host.calls.filter(x=>x.op==='cancel-run').length,1);assert.equal(result.carrierCancellation.confirmed,true);assert.equal(result.passed,false)
 assert.equal(result.restoration.featureFlags,false);assert.equal(host.calls.filter(x=>x.method==='settings/mutate').length,1)
})
test('a full already-enabled run preserves external flag changes with zero writes and an unconfirmed restoration',async()=>{
 const {runVisionAcceptanceWithFetch}=await modulePromise,host=fakeHost({rows:[{...ownRow,user:{enabled:true,computerUseEnabled:true},value:{enabled:true,computerUseEnabled:true}}],nativeMode:'local',prepareError:true,onCall(body,rows){if(body.op==='prepare'){rows[0].user.enabled=false;rows[0].value.enabled=false;rows[0].revision++}}}),result=await runVisionAcceptanceWithFetch(host.fetch,()=>{})
 assert.equal(result.enableProof,'already-enabled-readback');assert.equal(result.restoration.featureFlags,false);assert.equal(result.restorationProof.featureFlags,'unconfirmed');assert.equal(host.calls.filter(x=>x.method==='settings/mutate').length,0);assert.equal(result.passed,false)
})
test('a confirmed enable does not overwrite a later revision or another field changed externally',async()=>{
 const {runVisionAcceptanceWithFetch}=await modulePromise
 for(const change of['revision-only','unwritten-field','written-field']){const host=fakeHost({rows:[{...ownRow,user:{enabled:true},value:{enabled:true,computerUseEnabled:false}}],nativeMode:'local',prepareError:true,acceptMutation:true,onCall(body,rows){if(body.op==='prepare'){rows[0].revision++;if(change==='unwritten-field'){rows[0].user.enabled=false;rows[0].value.enabled=false}if(change==='written-field'){rows[0].user.computerUseEnabled=false;rows[0].value.computerUseEnabled=false}}}}),result=await runVisionAcceptanceWithFetch(host.fetch,()=>{})
 assert.equal(result.enableProof,'cas-confirmed-readback');assert.equal(host.calls.filter(x=>x.method==='settings/mutate').length,1);assert.equal(result.restoration.featureFlags,false);assert.equal(result.restorationProof.featureFlags,'unconfirmed');assert.equal(result.passed,false)}
})
test('a change between initial snapshot and enable is rejected before any settings write or fixture',async()=>{
 const {runVisionAcceptanceWithFetch}=await modulePromise;let reads=0
 const host=fakeHost({nativeMode:'local',onCall(body,rows){if(body.method==='settings/describe'&&++reads===2){rows[0].user.enabled=true;rows[0].value.enabled=true;rows[0].revision++}}}),result=await runVisionAcceptanceWithFetch(host.fetch,()=>{})
 assert.equal(result.error,'settings/conflict');assert.equal(result.restoration.featureFlags,false);assert.equal(host.calls.some(x=>x.method==='settings/mutate'||x.op==='prepare'),false);assert.equal(host.calls.filter(x=>x.op==='cancel-run').length,1)
})
test('another generation between the acknowledged enable and first readback stays unknown and is never restored',async()=>{
 const {runVisionAcceptanceWithFetch}=await modulePromise;let writes=0,changed=false
 const host=fakeHost({nativeMode:'local',acceptMutation:true,onCall(body,rows){if(body.method==='settings/mutate')writes++;if(body.method==='settings/describe'&&writes===1&&!changed){changed=true;rows[0].revision++}}}),result=await runVisionAcceptanceWithFetch(host.fetch,()=>{})
 assert.equal(result.error,'VISION_FEATURE_ENABLE_UNCONFIRMED');assert.equal(result.enableProof,'unconfirmed');assert.equal(result.restoration.featureFlags,false);assert.equal(host.calls.filter(x=>x.method==='settings/mutate').length,1);assert.equal(host.calls.some(x=>x.op==='prepare'||x.method==='session/prompt'),false);assert.equal(host.calls.filter(x=>x.op==='cancel-run').length,1)
})
