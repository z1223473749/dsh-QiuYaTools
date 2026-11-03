/** Real editor/renderer integration with a recorded live DeepSeek response.
 * No paid calls in this regression. The fixture is intentionally an arbitrary
 * object list (including lanterns and petals), not a fixed set of categories. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'
const output='artifacts/smart-theme'; await mkdir(output,{recursive:true})
execFileSync(process.execPath,['scripts/preview-ocean-settings.mjs','--generate-only'])
const html=await readFile('artifacts/ocean-scene/settings-preview.html')
const temporary=await mkdtemp(join(tmpdir(),'qiuya-smart-preview-'))
await build({entryPoints:['src/features/smart-theme/host.ts'],outfile:join(temporary,'host.mjs'),bundle:true,platform:'node',format:'esm'})
const {installSmartThemeHost}=await import(pathToFileURL(join(temporary,'host.mjs')))
const plan=JSON.parse(await readFile('tests/fixtures/smart-theme/moonfrost-plan.json','utf8'))
const handlers=new Map();let analyses=0,assetsWritten=0,modelsReady=false,reviewOutput=null,failNextReview=true,overviewCalls=0
const stop=installSmartThemeHost({profileContext:{dir:temporary},connection:{browserPeer:{principal:{kind:'owner'}},fetch:{register(route){handlers.set(route.path,route);return async()=>handlers.delete(route.path)}}},attachments:{async saveImage(input){return {attachmentId:'fixture-admitted',bytes:input.data.length}}},llm:{listProviders:()=>[{id:'deepseek-account',name:'DeepSeek Account'}],async listModels(){return modelsReady?[{id:'deepseek-v4-flash-vision-exp',name:'DeepSeek-V4-Flash',inputModalities:['text','image']},{id:'deepseek-v4.1-flash-1017',name:'DeepSeek-V4.1-Flash',inputModalities:['text','image']}]:[]},async prepareCall(config,_signal,configure){assert.equal(config.model,'deepseek-v4.1-flash-1017');analyses++;return{config:{...config,...configure({},{reasoning:{efforts:[{id:'off'}]}})},inputModalities:['text','image'],async *stream(request){let output=plan;if(!request.system.includes('contact sheet'))overviewCalls++;if(request.system.includes('contact sheet')){if(failNextReview){failNextReview=false;yield{type:'finish',reason:{kind:'max-tokens'}};return;}const descriptions=JSON.parse(request.messages[0].content[0].text).objects;output={regions:descriptions.map(({id})=>({id,visible:false}))};output=reviewOutput;}yield{type:'text-delta',index:0,text:JSON.stringify(output)};yield{type:'finish',reason:{kind:'stop'}}}}}}})
const server=createServer(async(request,response)=>{
  try{
    if(request.url?.startsWith('/api/qiuya-tools/smart-theme/')&&request.method==='POST'){
      const endpoint=request.url.slice('/api/qiuya-tools/smart-theme/'.length),route=handlers.get(request.url)
      if(!route){response.writeHead(404);response.end();return}
      const chunks=[];for await(const chunk of request)chunks.push(chunk)
      if(endpoint==='review'){const p=JSON.parse(Buffer.concat(chunks).toString()).payload;reviewOutput={regions:p.plan.regions.map(r=>{const c=p.crops.find(c=>c.id===r.id),map=p=>[(p[0]-c.x)/c.width,(p[1]-c.y)/c.height];return{id:r.id,choice:0,visible:true,positive:[map(r.polygon.reduce((a,p)=>[a[0]+p[0]/r.polygon.length,a[1]+p[1]/r.polygon.length],[0,0]))],negative:[],polygon:r.polygon.map(map),anchor:map(r.anchor),tip:map(r.tip),protect:[]}})};}
      // Replay the mask inference boundary for deterministic UI/GPU regression;
      // neural inference is exercised separately with real SlimSAM weights.
      if(endpoint==='runtime'){
        const envelope=JSON.parse(Buffer.concat(chunks).toString());
        const source=envelope.payload.part==='worker'?`self.onmessage=({data})=>{const outputs=data.jobs.map(j=>({id:j.id,width:256,height:256*j.height/j.width,mask:new Uint8Array(256*256).fill(255)}));self.postMessage({ok:true,outputs})}`:'';
        response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({type:'server-response',rpcId:envelope.rpcId,result:{ok:true,value:Buffer.from(source).toString('base64')}}));return;
      }
      const result=await route.fetch(new Request('http://fixture'+request.url,{method:'POST',headers:{'content-type':'application/json'},body:Buffer.concat(chunks)}))
      if(endpoint==='put-assets'&&result.status===200)assetsWritten++
      response.writeHead(result.status,{'content-type':'application/json'});response.end(await result.text());return
    }
    response.setHeader('content-type','text/html; charset=utf-8');response.end(html)
  }catch{response.writeHead(500);response.end('Fixture error')}
})
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
const browser=await chromium.launch({headless:true,...(process.platform==='darwin'?{executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{})})
try{
 const page=await browser.newPage({viewport:{width:1500,height:1040}}),errors=[]
 page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='warning'||message.type()==='error')console.log(message.text())})
 await page.goto('http://127.0.0.1:'+server.address().port)
 await page.getByRole('button',{name:'＋ 新建主题',exact:true}).click()
 const dialog=page.getByRole('dialog',{name:'自定义主题',exact:true})
 await dialog.getByLabel('主题名称',{exact:true}).fill('月下云海 · AI 动态风景')
 await dialog.locator('input[type=file]').setInputFiles('assets/q-moonfrost-scene.jpg')
 assert.equal(await dialog.getByLabel('动效强度',{exact:true}).inputValue(),'0.35')
 await dialog.getByRole('tab',{name:'氛围与配色',exact:true}).click()
 await dialog.locator('.qyt-editor-effect-group').first().getByRole('button',{name:'无',exact:true}).click()
 await dialog.locator('.qyt-editor-effect-group').last().getByRole('button',{name:'无',exact:true}).click()
 await dialog.getByRole('tab',{name:'智能动效',exact:true}).click()
 await page.waitForFunction(()=>document.querySelector('.qyt-ai-auto-model strong')?.textContent?.includes('正在自动检测'))
 assert.equal(await dialog.getByRole('button',{name:'✦ 分析图片并生成动效',exact:true}).isDisabled(),true)
 modelsReady=true
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')))
 await page.waitForFunction(()=>document.querySelector('.qyt-ai-auto-model strong')?.textContent?.includes('V4.1-Flash'))
 assert.equal(await dialog.getByLabel('分析模型',{exact:true}).count(),0,'model selection is automatic without a dropdown')

 await dialog.getByLabel('希望画面怎么动',{exact:true}).fill('根据画面实际对象设计微风、云雾和灯光变化，保护人物面部和建筑。')
 await dialog.getByRole('button',{name:'✦ 分析图片并生成动效',exact:true}).click()
 await dialog.locator('.qyt-editor-error').filter({hasText:'智能动效生成失败'}).waitFor()
 await dialog.getByRole('button',{name:'✦ 分析图片并生成动效',exact:true}).click()
 await page.waitForFunction(()=>document.querySelector('.qyt-custom-dialog iframe')?.contentDocument?.querySelector('[data-qyt-smart-motion=ready]'))
 assert.equal(await dialog.locator('.qyt-region-canvas').count(),0,'analysis completes directly into a playing preview, never the static region editor')
 await dialog.locator('.qyt-editor-stage').getByRole('button',{name:'修正区域',exact:true}).click()
 await dialog.locator('.qyt-region-canvas').waitFor()
 assert.match(await dialog.locator('.qyt-region-edit-status').innerText(),/播放已暂停/)
 await page.waitForFunction(()=>!document.querySelector('.qyt-editor-save').disabled)
 assert.equal(await dialog.getByLabel('动效强度',{exact:true}).inputValue(),'0.75','new AI themes use a visible default strength')
 assert.equal(await dialog.getByLabel('动效速度',{exact:true}).inputValue(),'1','new AI themes use normal playback speed')
 assert.equal(await dialog.locator('.qyt-ai-region').count(),1,'object list defaults to the current selection only')
 const expand=dialog.getByRole('button',{name:'展开',exact:true})
 assert.equal(await expand.getAttribute('aria-expanded'),'false')
 await expand.click()
 assert.equal(await dialog.locator('.qyt-ai-region').count(),plan.regions.length)
 assert.ok(await dialog.getByRole('button',{name:/檐下灯笼/}).count(),'objects are not restricted to hair/cloth/cloud/water')
 await dialog.getByRole('button',{name:/檐下灯笼/}).click()
 assert.equal(await dialog.locator('.qyt-ai-region').count(),1,'selecting an object collapses the list')
 assert.match(await dialog.locator('.qyt-ai-region').innerText(),/檐下灯笼/)
 await expand.click()
 await dialog.getByRole('button',{name:/长发发尾/}).click()
 assert.equal(await dialog.locator('.qyt-ai-region').count(),1)
 assert.match(await dialog.locator('.qyt-ai-region').innerText(),/长发发尾/)
 const stage=await dialog.locator('.qyt-editor-stage').boundingBox(),inspector=await dialog.locator('.qyt-editor-inspector').boundingBox()
 assert.ok(stage.width>800&&inspector.x>=stage.x+stage.width-1,'large side-by-side workspace')
 await dialog.getByRole('button',{name:'设置固定点',exact:true}).click()
 const pinBox=await dialog.locator('.qyt-region-canvas').boundingBox()
 await page.mouse.click(pinBox.x+pinBox.width*.735,pinBox.y+pinBox.height*.22)
 await dialog.locator('.qyt-editor-inspector').evaluate(el=>el.scrollTop=190)
 await dialog.screenshot({path:output+'/editor-regions.png'})
 // Paint a protected correction, then verify the rebuilt immutable asset is used.
 await dialog.getByRole('button',{name:'保持静止',exact:true}).click()
 const canvas=dialog.locator('.qyt-region-canvas'),box=await canvas.boundingBox()
 await page.mouse.move(box.x+box.width*.765,box.y+box.height*.14);await page.mouse.down();await page.mouse.move(box.x+box.width*.77,box.y+box.height*.16);await page.mouse.up()
 await page.waitForFunction(()=>!document.querySelector('.qyt-editor-save').disabled)
 await dialog.locator('.qyt-editor-stage').getByRole('button',{name:'主题预览',exact:true}).click()
 const preview=page.frameLocator('.qyt-custom-dialog iframe')
 const gpu=preview.locator('[data-qyt-smart-motion="ready"]')
 try { await gpu.waitFor({timeout:15000}) } catch(error) {
  console.log(await preview.locator('body').evaluate(el=>({theme:el.dataset.qytQTheme,canvas:el.querySelector('[data-qyt-smart-motion]')?.outerHTML,scene:el.querySelector('[data-qyt-landscape-scene]')?.outerHTML.slice(0,500)})))
  await dialog.screenshot({path:output+'/debug-renderer.png'});throw error
 }
 await page.waitForFunction(()=>{
  const frame=document.querySelector('.qyt-custom-dialog iframe'),canvas=frame?.contentDocument?.querySelector('[data-qyt-smart-motion]')
  return canvas&&getComputedStyle(canvas).visibility==='visible'
 })
 await dialog.locator('.qyt-editor-inspector').evaluate(el=>el.scrollTop=190)
 await dialog.screenshot({path:output+'/editor-preview.png'})
 await dialog.getByRole('tab',{name:'图片',exact:true}).click();await dialog.screenshot({path:output+'/editor-image.png'})
 await dialog.getByRole('tab',{name:'氛围与配色',exact:true}).click();await dialog.screenshot({path:output+'/editor-atmosphere.png'})
 await dialog.getByRole('tab',{name:'智能动效',exact:true}).click()
 // A video preserves gradients and avoids a short GIF loop snapping back.
 const video=await gpu.evaluate(async canvas=>{
  if(typeof MediaRecorder==='undefined'||!canvas.captureStream)return null
  const mime=['video/mp4;codecs=avc1.42001E','video/mp4','video/webm;codecs=vp9'].find(type=>MediaRecorder.isTypeSupported(type))
  if(!mime)return null
  const stream=canvas.captureStream(30),chunks=[],recorder=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:4_000_000})
  const complete=new Promise((resolve,reject)=>{recorder.ondataavailable=event=>{if(event.data.size)chunks.push(event.data)};recorder.onerror=()=>reject(Error('Preview recording failed'));recorder.onstop=resolve})
  recorder.start(200);await new Promise(resolve=>setTimeout(resolve,8000));recorder.stop();await complete;stream.getTracks().forEach(track=>track.stop())
  const blob=new Blob(chunks,{type:recorder.mimeType})
  const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=reject;reader.readAsDataURL(blob)})
  return{mime:recorder.mimeType,extension:mime.startsWith('video/mp4')?'mp4':'webm',data}
 })
 if(video){await writeFile(output+'/motion-visible.'+video.extension,Buffer.from(video.data,'base64'));await writeFile(output+'/video-preview.json',JSON.stringify({mime:video.mime,file:'motion-visible.'+video.extension,durationSeconds:8}))}
 if(video){
  const metrics=await inspectRecordedMotion(page,video)
  await writeFile(output+'/motion-metrics.json',JSON.stringify(metrics,null,2))
  for(const label of ['hair','cloth','cloud'])assert.ok(metrics.patches.some(p=>p.label===label&&p.displacement>=5&&p.confidence>.5),label+' motion must move by at least 5 actual video pixels')
 }

 // Capture real GPU output to an animated GIF, without generated replacement art.
 const gpuBounds=await gpu.boundingBox(),frames=[],width=640,height=Math.round(640*gpuBounds.height/gpuBounds.width)
 for(let i=0;i<28;i++){
  const png=await gpu.screenshot()
  const indices=await page.evaluate(async({base64,width,height})=>{
   const image=new Image();image.src='data:image/png;base64,'+base64;await image.decode()
   const c=document.createElement('canvas');c.width=width;c.height=height;const ctx=c.getContext('2d');ctx.drawImage(image,0,0,width,height)
   const rgba=ctx.getImageData(0,0,width,height).data,output=new Uint16Array(width*height)
   for(let i=0;i<output.length;i++)output[i]=(rgba[i*4]>>3)*1024+(rgba[i*4+1]>>3)*32+(rgba[i*4+2]>>3)
   return Array.from(output)
  },{base64:png.toString('base64'),width,height})
  frames.push(Uint16Array.from(indices));await page.waitForTimeout(65)
 }
 assert.ok(frames.some(frame=>frame.some((v,i)=>v!==frames[0][i])),'actual scene pixels animate')
 // The face is inside the recorded protection polygon. Its actual rendered
 // pixels must stay fixed while the surrounding scene animates.
 const fitScale=Math.max(gpuBounds.width/1600,gpuBounds.height/900)
 const faceX=Math.round((.76*1600*fitScale+(gpuBounds.width-1600*fitScale)/2)/gpuBounds.width*width)
 const faceY=Math.round((.11*900*fitScale+(gpuBounds.height-900*fitScale)/2)/gpuBounds.height*height)
 for(let y=-1;y<=1;y++)for(let x=-1;x<=1;x++){
  const index=(faceY+y)*width+faceX+x
  assert.ok(frames.every(frame=>frame[index]===frames[0][index]),'protected face pixels remain unchanged')
 }
 await writeFile(output+'/motion-preview.gif',gif(frames,width,height,10))
 assert.equal(await page.evaluate(()=>window.__oceanSettingsFixture.getSnapshot().value.qCustomThemes?.length??0),0,'generated motion stays a draft until explicit save')
 assert.equal(assetsWritten,0,'unsaved motion never persists its pixel assets')
 await dialog.getByRole('button',{name:'保存并应用',exact:true}).click();await dialog.waitFor({state:'detached'})
 const saved=await page.evaluate(()=>window.__oceanSettingsFixture.getSnapshot().value.qCustomThemes[0])
 assert.match(saved.smartMotion.assetId,/^[a-f0-9]{64}$/);assert.equal(saved.smartMotion.strokes.length,1)
 assert.ok(Math.abs(saved.smartMotion.regions[0].anchor[0]-.735)<.005,'manual root correction persists')
 assert.ok(JSON.stringify(saved.smartMotion).length<20000,'configuration carries compact recipes, not layers')
 assert.equal(assetsWritten,1)
 assert.equal(overviewCalls,1,'a review retry reuses the paid overview instead of analyzing the image again')
 await page.reload();await page.getByRole('button',{name:'编辑当前主题',exact:true}).click()
 await dialog.locator('.qyt-ai-region').first().waitFor()
 assert.equal(await dialog.locator('.qyt-ai-region').count(),1,'reopening restores the collapsed list')
 await page.waitForFunction(()=>{
  const frame=document.querySelector('.qyt-custom-dialog iframe'),canvas=frame?.contentDocument?.querySelector('[data-qyt-smart-motion]')
  return canvas?.dataset.qytSmartMotion==='ready'&&getComputedStyle(canvas).visibility==='visible'
 })
 assert.equal(analyses,2+plan.regions.length*2,'reload and playback use saved assets, never another model call')
 await dialog.getByRole('button',{name:'静态',exact:true}).click()
 await preview.locator('[data-qyt-smart-motion]').waitFor({state:'detached'})
 await dialog.getByRole('button',{name:'动态',exact:true}).click();await gpu.waitFor()
 await page.emulateMedia({reducedMotion:'reduce'});await gpu.waitFor({state:'detached'})
 await page.emulateMedia({reducedMotion:'no-preference'});await gpu.waitFor()
 await page.setViewportSize({width:390,height:820})
 await dialog.getByRole('button',{name:'修正区域',exact:true}).first().click()
 await dialog.locator('.qyt-region-canvas').scrollIntoViewIfNeeded()
 await dialog.screenshot({path:output+'/editor-narrow.png'})
 const fit=await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth&&el.getBoundingClientRect().width<=390)
 assert.ok(fit,'workspace collapses without horizontal overflow')
 const footer=await dialog.getByRole('button',{name:'保存并应用',exact:true}).boundingBox();assert.ok(footer.y+footer.height<=820)
 await dialog.getByRole('button',{name:'取消',exact:true}).click()
 await page.setViewportSize({width:1500,height:1040})
 await page.getByRole('button',{name:'编辑当前主题',exact:true}).click()
 await dialog.getByRole('button',{name:'删除主题',exact:true}).click()
 await dialog.getByRole('button',{name:'确认删除',exact:true}).click()
 await dialog.waitFor({state:'detached'})
 assert.equal(await page.evaluate(()=>window.__oceanSettingsFixture.getSnapshot().value.qCustomThemes.length),0,'deleting a saved smart theme removes its card')
 assert.equal(await page.evaluate(()=>window.__oceanSettingsFixture.getSnapshot().value.qThemeId),'moonfrost','deleting the active smart theme restores the default')
 assert.deepEqual(errors,[])
 console.log(JSON.stringify({passed:true,recordedLiveDeepSeekObjects:plan.regions.map(r=>r.label),analyses,assetsWritten,checks:['draft only until save','review retry reuses overview','saved theme deletion','wide workspace','adaptive objects','mask correction','GPU pixel motion','immutable save/reload','no API during playback','static/reduced motion','narrow layout'],preview:output+'/editor-preview.png',animation:output+(video?'/motion-visible.'+video.extension:'/motion-preview.gif')}))
}finally{await browser.close();stop();await new Promise(resolve=>server.close(resolve));await rm(temporary,{recursive:true,force:true})}
function gif(frames,width,height,delay){
 const le=n=>Buffer.from([n&255,n>>8&255]),chunks=[Buffer.from('GIF89a'),le(width),le(height),Buffer.from([0xf7,0,0])]
 // Adaptive median-cut palette preserves the scene's many pale blue/gray tones.
 const counts=new Uint32Array(32768);for(const frame of frames)for(const color of frame)counts[color]++
 const rgb=color=>[(color>>10)*8+4,((color>>5)&31)*8+4,(color&31)*8+4]
 const box=colors=>{const min=[255,255,255],max=[0,0,0];let weight=0;for(const c of colors){weight+=counts[c];const p=rgb(c);for(let k=0;k<3;k++){min[k]=Math.min(min[k],p[k]);max[k]=Math.max(max[k],p[k])}}const ranges=max.map((v,k)=>v-min[k]);return{colors,weight,axis:ranges.indexOf(Math.max(...ranges)),score:Math.max(...ranges)*Math.sqrt(weight)}}
 const boxes=[box(Array.from(counts.keys()).filter(c=>counts[c]))]
 while(boxes.length<256){let index=-1;for(let i=0;i<boxes.length;i++)if(boxes[i].colors.length>1&&(index<0||boxes[i].score>boxes[index].score))index=i;if(index<0)break;const current=boxes[index],colors=current.colors.sort((a,b)=>rgb(a)[current.axis]-rgb(b)[current.axis]);let sum=0,split=1;for(;split<colors.length;split++){sum+=counts[colors[split-1]];if(sum>=current.weight/2)break}boxes.splice(index,1,box(colors.slice(0,split)),box(colors.slice(split)))}
 const palette=Buffer.alloc(768),paletteColors=boxes.map((b,i)=>{const color=[0,0,0];for(const c of b.colors){const p=rgb(c);for(let k=0;k<3;k++)color[k]+=p[k]*counts[c]/b.weight}for(let k=0;k<3;k++)palette[i*3+k]=Math.round(color[k]);return color})
 const lookup=new Uint8Array(32768);for(let c=0;c<counts.length;c++)if(counts[c]){const color=rgb(c);let best=Infinity;for(let i=0;i<paletteColors.length;i++){const p=paletteColors[i],distance=(p[0]-color[0])**2+(p[1]-color[1])**2+(p[2]-color[2])**2;if(distance<best){best=distance;lookup[c]=i}}}
 chunks.push(palette,Buffer.from([0x21,0xff,0x0b]),Buffer.from('NETSCAPE2.0'),Buffer.from([3,1,0,0,0]))
 for(const frame of frames){
  chunks.push(Buffer.from([0x21,0xf9,4,0x04]),le(delay),Buffer.from([0,0]),Buffer.from([0x2c]),le(0),le(0),le(width),le(height),Buffer.from([0,8]))
  const bytes=[];let bits=0,buffer=0,n=0;const code=value=>{buffer|=value<<bits;bits+=9;while(bits>=8){bytes.push(buffer&255);buffer>>>=8;bits-=8}}
  code(256);for(const value of frame){code(lookup[value]);if(++n===200){code(256);n=0}}code(257);if(bits)bytes.push(buffer&255)
  const data=Buffer.from(bytes);for(let i=0;i<data.length;i+=255){const block=data.subarray(i,i+255);chunks.push(Buffer.from([block.length]),block)}chunks.push(Buffer.from([0]))
 }
 chunks.push(Buffer.from([0x3b]));return Buffer.concat(chunks)
}

/** Inspect the encoded delivery, rather than merely accepting changed GPU pixels. */
async function inspectRecordedMotion(page,video){
 return page.evaluate(async({data,mime})=>{
  const player=document.createElement('video');player.muted=true;player.src='data:'+mime+';base64,'+data
  await new Promise((resolve,reject)=>{player.onloadeddata=resolve;player.onerror=reject})
  const canvas=document.createElement('canvas');canvas.width=player.videoWidth;canvas.height=player.videoHeight
  const ctx=canvas.getContext('2d',{willReadFrequently:true}),frames=[]
  for(const time of [.4,2.4,4.4,6.4,7.4]){
   player.currentTime=Math.min(time,player.duration-.1);await new Promise(resolve=>player.onseeked=resolve)
   ctx.drawImage(player,0,0);frames.push(ctx.getImageData(0,0,canvas.width,canvas.height).data)
  }
  const fit=Math.max(canvas.width/1600,canvas.height/900),patches=[]
  for(const [label,u,v]of[['hair',.64,.28],['cloth',.54,.76],['cloud',.25,.57]]){
   const x=Math.round(u*1600*fit+(canvas.width-1600*fit)/2),y=Math.round(v*900*fit+(canvas.height-900*fit)/2)
   if(x<32||y<32||x>canvas.width-32||y>canvas.height-32)continue
   for(const frame of frames.slice(1)){
    let best=Infinity,bx=0,by=0,zero=0
    for(let dy=-24;dy<=24;dy++)for(let dx=-24;dx<=24;dx++){
     let error=0
     for(let py=-6;py<=6;py+=2)for(let px=-6;px<=6;px+=2){const a=((y+py)*canvas.width+x+px)*4,b=((y+py+dy)*canvas.width+x+px+dx)*4;for(let k=0;k<3;k++)error+=(frames[0][a+k]-frame[b+k])**2}
     if(dx===0&&dy===0)zero=error
     if(error<best){best=error;bx=dx;by=dy}
    }
    patches.push({label,dx:bx,dy:by,displacement:Math.hypot(bx,by),confidence:zero?1-best/zero:0})
   }
  }
  return{duration:player.duration,width:canvas.width,height:canvas.height,patches}
 },video)
}
