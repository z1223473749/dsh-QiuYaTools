import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const directory = await mkdtemp(join(tmpdir(), 'qiuya-smart-theme-test-'))
await build({ entryPoints: ['src/smart-motion.ts', 'src/features/smart-theme/host.ts', 'src/features/smart-theme/model-route.ts', 'src/client/smart-theme-processing.ts', 'src/client/smart-theme-api.ts', 'src/client/smart-segmentation.ts'], outdir: directory, outbase: 'src', bundle: true, platform: 'node', format: 'esm' })
const api = await import(pathToFileURL(join(directory, 'smart-motion.js')))
const { discoverSmartThemeModels } = await import(pathToFileURL(join(directory, 'features/smart-theme/model-route.js')))
const { installSmartThemeHost, createMotionAssetStore } = await import(pathToFileURL(join(directory, 'features/smart-theme/host.js')))
const { snapMotionGeometry } = await import(pathToFileURL(join(directory, 'client/smart-segmentation.js')))
const { smartThemeRequest } = await import(pathToFileURL(join(directory, 'client/smart-theme-api.js')))
const { refineMotionMask, featherMotionMask, extendMotionBackground } = await import(pathToFileURL(join(directory, 'client/smart-theme-processing.js')))
test.after(() => rm(directory, { recursive: true, force: true }))
const plan = { version: 1, regions: [{ id: 'r0', kind: 'sway', label: '柳枝', polygon: [[.1,.1],[.3,.1],[.3,.8],[.1,.8]], anchor: [.2,.1], tip: [.2,.8], amplitude: .008, speed: 1, direction: 0, enabled: true }], protect: [[[.4,.3],[.5,.3],[.5,.4]]] }
const image = 'data:image/webp;base64,UklGRg=='
const assets = { version: 1, sourceHash: 'a'.repeat(64), maskHash: 'b'.repeat(64), width: 800, height: 600, source: image, plate: image, masks: [image,image,image], protection: image }
function fixture(t, options = {}) {
  const routes = new Map(), calls = [], state = { output: JSON.stringify(plan), images: 0, imageCapable: true, blocked: false, reasoningEfforts: ['off'] }
  const ctx = { profileContext: { dir: join(directory, Math.random().toString(36).slice(2)) }, connection: { browserPeer: { principal: { kind: 'owner' } }, fetch: { register(route) { routes.set(route.path, route); return async () => routes.delete(route.path) } } }, attachments: { async saveImage(input) { state.images++; assert.ok(input.data.length); return { attachmentId: 'verified-image' } } }, llm: {
    listProviders: () => [{ id: 'custom-name', name: 'My API' }], async listModels() { return [{ id: 'deepseek-flash', name: 'DeepSeek Flash', inputModalities: ['text','image'] }, {id: 'deepseek-v4-pro',name:'Pro',inputModalities:['text']}] },
    async prepareCall(route, signal, configure) {
      calls.push(route); const config = { ...route, ...configure({}, { reasoning: { efforts: state.reasoningEfforts.map(id=>({id})) } }) }
      state.lastConfig=config
      return { config, inputModalities: state.imageCapable ? ['text','image'] : ['text'], async *stream(request) {
        assert.deepEqual(request.tools, []); assert.equal(request.messages[0].content[1].type, 'image')
        if (state.blocked) await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), {once:true}))
        yield { type: 'text-delta', index: 0, text: state.output }; yield { type: 'block-end', index: 0, block: { type: 'text', text: state.output } }; yield { type: 'finish', reason: { kind: 'stop' } }
      } }
    },
  } }
  const stop = installSmartThemeHost(ctx, { timeoutMs: 1000, ...options }); t.after(stop)
  const request = async (endpoint, payload = {}) => {
    const response = await routes.get(`${api.SMART_THEME_CHANNEL}/${api.SMART_THEME_ENDPOINT}${endpoint}`).fetch(new Request('http://fixture', {method:'POST',body:JSON.stringify({type:'client-request',rpcId:'rpc/client:1',method:api.SMART_THEME_ENDPOINT+endpoint,payload})}))
    return { response, ...(response.status === 200 ? await response.json() : {}) }
  }
  const analyze = () => request('analyze', { requestId: 'job-1', image, prompt: '让实际对象自然运动' })
  return {ctx,calls,state,request,analyze,stop,routes}
}
test('client and Host exchange namespaced methods over a native single-segment RPC channel', async t => {
  const f = fixture(t)
  f.ctx.get = name => f.ctx[name]
  f.ctx.connection.rpc = { async call(channel, method, payload) {
    assert.match(channel, /^\/[A-Za-z0-9._~-]+$/)
    assert.equal(method, api.SMART_THEME_ENDPOINT + 'models')
    const response = await f.routes.get(channel + '/' + method).fetch(new Request('http://fixture', {method:'POST',body:JSON.stringify({type:'client-request',rpcId:'rpc/client:1',method,payload})}))
    assert.equal(response.status, 200)
    const envelope = await response.json()
    assert.equal(envelope.rpcId, 'rpc/client:1')
    return envelope.result
  } }
  const models = await smartThemeRequest(f.ctx, 'models', {})
  assert.equal(models[0].model, 'deepseek-flash')
})
test('crop review maps exact local contours, drops rejected objects and refuses invented or degenerate regions', () => {
  const crops=[{id:'r0',x:.1,y:.2,width:.4,height:.5}]
  const reviewed={regions:[{id:'r0',visible:true,positive:[[.5,.5]],negative:[[.95,.95]],polygon:[[.1,.1],[.8,.1],[.8,.8],[.1,.8]],anchor:[.2,.1],tip:[.7,.8],protect:[[[.2,.2],[.3,.2],[.3,.3]]]}]}
  assert.equal(api.isMotionCrops(crops,plan),true)
  assert.equal(api.isMotionCrops([{...crops[0],x:.9}],plan),false)
  const result=api.parseMotionReview(JSON.stringify(reviewed),plan,crops)
  assert.ok(Math.abs(result.regions[0].polygon[0][0]-.14)<1e-8)
  assert.ok(Math.abs(result.regions[0].polygon[0][1]-.25)<1e-8)
  assert.equal(result.protect.length,1)
  assert.equal(api.parseMotionReview(JSON.stringify({regions:[{id:'r0',visible:false}]}),plan,crops).regions.length,0)
  assert.throws(()=>api.parseMotionReview(JSON.stringify({regions:[{...reviewed.regions[0],id:'r7'}]}),plan,crops),/invalid-plan/)
  assert.throws(()=>api.parseMotionReview(JSON.stringify({regions:[]}),plan,crops),/invalid-plan/)
  assert.equal(api.parseMotionReview(JSON.stringify({regions:[{...reviewed.regions[0],tip:reviewed.regions[0].anchor}]}),plan,crops).regions.length,0)
})
test('Host admits an explicit crop review and rejects mismatched crop metadata before model dispatch', async t => {
  const f=fixture(t)
  const payload={requestId:'review-1',image,prompt:'',plan,crops:[{id:'r0',x:.1,y:.1,width:.4,height:.8}]}
  assert.equal((await f.request('review',{...payload,crops:[{...payload.crops[0],id:'r7'}]})).result.error.code,'invalid-request')
  assert.equal(f.calls.length,0)
  f.state.output=JSON.stringify({regions:[{id:'r0',visible:false}]})
  const response=await f.request('review',payload)
  assert.equal(response.result.ok,true)
  assert.equal(response.result.value.plan.regions.length,0)
  assert.equal(f.calls[0].maxTokens,7168)
})
test('semantic mask review selects only supplied candidate ids and drops unsuitable objects', () => {
  const crops=[{id:'r0',x:.1,y:.2,width:.4,height:.5}], choices={r0:[0,1,2]}
  const selected=api.parseMotionChoices(JSON.stringify({regions:[{id:'r0',choice:2}]}),plan,crops,choices)
  assert.equal(selected.regions[0].segmentation.choice,2)
  assert.equal(api.isMotionPlan(selected),true)
  assert.equal(api.parseMotionChoices(JSON.stringify({regions:[{id:'r0',choice:-1}]}),plan,crops,choices).regions.length,0)
  assert.throws(()=>api.parseMotionChoices(JSON.stringify({regions:[{id:'r0',choice:7}]}),plan,crops,choices),/invalid-plan/)
})
test('Host validates candidate review bounds before dispatch and accepts the last supplied candidate', async t => {
  const f=fixture(t)
  f.state.reasoningEfforts=['off','low','high']
  const payload={requestId:'candidate-review',image,prompt:'',plan,crops:[{id:'r0',x:.1,y:.1,width:.4,height:.8}],choices:{r0:[0,23]}}
  f.state.output=JSON.stringify({regions:[{id:'r0',choice:23}]})
  const result=await f.request('review',payload)
  assert.equal(result.result.ok,true)
  assert.equal(result.result.value.plan.regions[0].segmentation.choice,23)
  assert.equal(f.calls[0].maxTokens,24576,'visual selection reserves enough room for the account model reasoning and final answer')
  assert.equal(api.isMotionPlan(result.result.value.plan),true)
  assert.equal(f.state.lastConfig.reasoningEffort,'low')
  await f.request('review',{...payload,choices:{r0:[23]}})
  assert.equal(f.calls[1].maxTokens,1024)
  assert.equal(f.state.lastConfig.reasoningEffort,'off')
  for(const choices of [{r0:[24]},{r0:[.5]},{r0:Array(25).fill(0)}]){
    assert.equal((await f.request('review',{...payload,choices})).result.error.code,'invalid-request')
  }
  assert.equal(f.calls.length,2)
})
test('segmented motion fixes the actual material root instead of adjacent skin', () => {
  const pixels=new Uint8ClampedArray(10*10*4)
  for(let y=2;y<=8;y++)for(let x=6;x<=8;x++)pixels[(y*10+x)*4+3]=255
  const geometry=snapMotionGeometry({...plan.regions[0],anchor:[.3,.2],tip:[.6,.8]},pixels,10,10)
  assert.deepEqual(geometry.anchor,[.65,.25])
  assert.deepEqual(geometry.tip,[.65,.85])
})
test('motion data validates arbitrary object labels and rejects executable, unbounded and mismatched recipes', () => {
  assert.equal(api.isMotionPlan(plan), true)
  assert.deepEqual(api.parseMotionPlan('```json\n'+JSON.stringify(plan)+'\n```'), plan)
  assert.deepEqual(api.parseMotionPlan(JSON.stringify({...plan,protect:plan.protect.map(polygon=>({label:'保护区域',polygon}))})),plan)
  for (const change of [{kind:'javascript'}, {polygon:[[NaN,0],[0,0],[1,1]]}, {amplitude:100}, {speed:5}, {label:'x'.repeat(33)}]) assert.equal(api.isMotionPlan({...plan,regions:[{...plan.regions[0],...change}]}), false)
  assert.equal(api.isMotionPlan({...plan,regions:[plan.regions[0],plan.regions[0]]}), false)
  assert.equal(api.isSmartMotion({...plan,assetId:'a'.repeat(64),sourceHash:'b'.repeat(64),strokes:[{regionId:'missing',mode:'paint',radius:.01,points:[[.1,.2]]}]}), false)
  const signature=api.maskSignature(plan,[])
  assert.equal(api.maskSignature({...plan,regions:[{...plan.regions[0],enabled:false,amplitude:.015,speed:2}]},[]),signature)
  assert.notEqual(api.maskSignature({...plan,regions:[{...plan.regions[0],kind:'ripple'}]},[]),signature)
})
test('Host discovers DeepSeek under arbitrary provider names and analyzes only admitted images', async t => {
  const f=fixture(t); const models=await f.request('models')
  assert.equal(models.result.value.length,1)
  const result=await f.analyze(); assert.equal(result.result.ok,true); assert.deepEqual(result.result.value.plan,plan)
  assert.equal(f.state.images,1); assert.equal(f.calls[0].model,'deepseek-flash')
})
test('Host rejects ownerless calls and never lets client fields select a destination', async t => {
  const f=fixture(t); f.ctx.connection.browserPeer.principal.kind='guest'
  assert.equal((await f.request('models')).response.status,403)
  f.ctx.connection.browserPeer.principal.kind='owner'
  const result=await f.request('analyze',{requestId:'x',image,prompt:'',provider:'https://evil',model:'anything'})
  assert.equal(result.result.ok,true); assert.equal(f.calls[0].provider,'custom-name'); assert.equal(f.calls[0].model,'deepseek-flash')
})
test('captured exact model capability must still support images at dispatch', async t => {
  const f=fixture(t); f.state.imageCapable=false
  const result=await f.analyze(); assert.equal(result.result.error.code,'unconfigured'); assert.equal(f.state.images,0)
})
test('invalid and oversized model output never becomes a saved theme', async t => {
  const f=fixture(t); f.state.output='{"version":1,"regions":[{"kind":"eval"}]}'
  assert.equal((await f.analyze()).result.error.code,'invalid-plan')
})
test('cancellation releases busy state and bounds unresponsive generation', async t => {
  const f=fixture(t); f.state.blocked=true
  const pending=f.analyze(); await new Promise(resolve=>setTimeout(resolve,20))
  assert.equal((await f.analyze()).result.error.code,'busy')
  await f.request('cancel',{requestId:'job-1'})
  assert.equal((await pending).result.error.code,'cancelled')
})
test('timeout finishes independently from a stalled stream', async t => {
  const f=fixture(t,{timeoutMs:25});f.state.blocked=true
  assert.equal((await f.analyze()).result.error.code,'cancelled')
})
test('profile assets are immutable, bounded, deduplicated and digest verified', async () => {
  const path=join(directory,'assets'),store=createMotionAssetStore(path)
  const id=await store.put(assets); assert.equal(await store.put(assets),id);assert.deepEqual(await store.get(id),assets)
  await assert.rejects(store.get('../credentials'))
  await writeFile(join(path,id+'.json'),JSON.stringify({...assets,width:100}))
  await assert.rejects(store.get(id),/invalid-assets/)
  await assert.rejects(store.put({...assets,source:'https://example.com'}),/invalid-assets/)
})
test('discarding a draft deletes unreferenced assets but protects saved themes and other saving drafts', async t => {
  let referenced=false
  const f=fixture(t,{isAssetReferenced:()=>referenced})
  const a=await f.request('put-assets',{assets,leaseId:'draft-a'}),assetId=a.result.value.assetId
  await f.request('put-assets',{assets,leaseId:'draft-b'})
  assert.equal((await f.request('discard-assets',{assetId,leaseId:'draft-a'})).result.value.removed,false)
  assert.equal((await f.request('get-assets',{assetId})).result.ok,true)
  assert.equal((await f.request('discard-assets',{assetId,leaseId:'draft-b'})).result.value.removed,true)
  assert.equal((await f.request('get-assets',{assetId})).result.ok,false)
  await f.request('put-assets',{assets,leaseId:'saved-draft'});referenced=true
  assert.equal((await f.request('discard-assets',{assetId,leaseId:'saved-draft'})).result.value.removed,false)
  assert.equal((await f.request('get-assets',{assetId})).result.ok,true)
  referenced=false
  assert.equal((await f.request('discard-assets',{assetId})).result.value.removed,true)
  assert.equal((await f.request('discard-assets',{assetId:'../outside'})).result.error.code,'invalid-request')
})
test('failure diagnostics record phases and bounded facts without model text or image bytes', async t => {
  const f=fixture(t);f.state.output='not json - private response'
  assert.equal((await f.analyze()).result.ok,false)
  const record=JSON.parse(await readFile(join(f.ctx.profileContext.dir,'qiuya-smart-theme-last-error.json'),'utf8'))
  assert.equal(record.phase,'parse-plan');assert.equal(record.outputChars,f.state.output.length)
  assert.equal(JSON.stringify(record).includes('private response'),false)
  assert.equal(JSON.stringify(record).includes('base64'),false)
})
test('local mask refinement respects color boundaries and background extension replaces erased content', () => {
  const pixels=new Uint8ClampedArray([0,0,0,255, 255,0,0,255, 0,0,0,255])
  const refined=refineMotionMask(new Uint8ClampedArray([0,255,0]),pixels,3,1)
  assert.ok(refined[1]>240);assert.ok(refined[0]<10)
  const repaired=extendMotionBackground(pixels,new Uint8ClampedArray([0,255,0]),3,1)
  assert.equal(repaired[4],0);assert.equal(repaired[0],pixels[0]);assert.equal(repaired[7],255)
})

test('natural motion masks pin selection boundaries and protected holes without changing the interior', () => {
  const w=64,h=64,mask=new Uint8ClampedArray(w*h)
  for(let y=8;y<56;y++)for(let x=8;x<56;x++)mask[y*w+x]=255
  for(let y=24;y<32;y++)for(let x=24;x<32;x++)mask[y*w+x]=0
  const soft=featherMotionMask(mask,w,h)
  assert.equal(soft[8*w+16],0,'the outer silhouette is pinned')
  assert.equal(soft[23*w+28],0,'the edge next to a protected face is pinned')
  assert.equal(soft[28*w+28],0,'protected pixels stay excluded')
  assert.equal(soft[44*w+44],255,'the interior keeps full motion weight')
  assert.ok(soft[11*w+16]>soft[9*w+16]&&soft[11*w+16]<255,'displacement ramps gradually')
  assert.deepEqual(featherMotionMask(new Uint8ClampedArray(16),4,4),new Uint8ClampedArray(16))
})

test('automatic routing recognizes current and future DeepSeek vision names and chooses the newest', async () => {
  const models=await discoverSmartThemeModels({
    listProviders:()=>[{id:'deepseek-account',name:'DeepSeek Account'}],
    async listModels(){return [
      {id:'deepseek-v4-flash-vision-exp',name:'DeepSeek-V4-Flash',inputModalities:['text','image']},
      {id:'deepseek-v4.1-flash-1017',name:'DeepSeek-V4.1-Flash',inputModalities:['text','image']},
      {id:'deepseek-v5-flash-1201',name:'DeepSeek-V5-Flash',inputModalities:['text','image']},
      {id:'deepseek-v6-pro',name:'DeepSeek-V6-Pro',inputModalities:['text']},
    ]}
  })
  assert.deepEqual(models.map(m=>m.model),['deepseek-v5-flash-1201','deepseek-v4.1-flash-1017','deepseek-v4-flash-vision-exp'])
})
test('automatic routing resolves omitted capabilities, respects text-only declarations and prefers the signed-in account', async () => {
  const resolutions=[]
  const models=await discoverSmartThemeModels({
    listProviders:()=>[{id:'custom',name:'DeepSeek API'},{id:'deepseek-account',name:'DeepSeek Account'}],
    async listModels(provider){return provider==='custom'?[{id:'deepseek-flash',name:'DeepSeek Flash',inputModalities:['image']}]:[
      {id:'deepseek-current',name:'DeepSeek Current'},
      {id:'deepseek-pro',name:'DeepSeek Pro',inputModalities:['text']},
    ]},
    async resolveModelInfo(provider,id){resolutions.push([provider,id]);return{id,name:'DeepSeek-V4.1-Flash',inputModalities:['text','image']}}
  })
  assert.equal(models[0].provider,'deepseek-account');assert.equal(models[0].model,'deepseek-current')
  assert.deepEqual(resolutions,[['deepseek-account','deepseek-current']]);assert.equal(models.length,2)
})
test('a failed unrelated provider does not hide an available account model', async () => {
  const models=await discoverSmartThemeModels({
    listProviders:()=>[{id:'offline',name:'Custom'},{id:'deepseek-account',name:'DeepSeek Account'}],
    async listModels(provider){if(provider==='offline')throw Error('offline');return[{id:'deepseek-flash',name:'DeepSeek-V4.1-Flash',inputModalities:['image']}]}
  })
  assert.equal(models.length,1);assert.equal(models[0].provider,'deepseek-account')
})
