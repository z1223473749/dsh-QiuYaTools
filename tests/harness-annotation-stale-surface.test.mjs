import test from'node:test'
import assert from'node:assert/strict'
import{build}from'esbuild'
import{JSDOM}from'jsdom'
import React from'react'
import{createRoot}from'react-dom/client'
import{createRequire}from'node:module'
import{mkdtemp,writeFile,rm}from'node:fs/promises'
import{tmpdir}from'node:os'
import{join}from'node:path'
import{pathToFileURL,fileURLToPath}from'node:url'
import{staleStyleSurfaceFacts}from'../scripts/harness-workbench-ui-evidence.mjs'
const require=createRequire(import.meta.url),repository=fileURLToPath(new URL('../',import.meta.url)),temporary=await mkdtemp(join(tmpdir(),'qyt-annotation-dom-')),bundle=await build({stdin:{resolveDir:repository,contents:"export {AnnotationEditor} from './src/features/annotations/Editor.tsx'"},bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'one-actual-react-instance',setup(api){api.onResolve({filter:/^react(?:\/.*)?$/},args=>({path:pathToFileURL(require.resolve(args.path)).href,external:true}))}}]});await writeFile(join(temporary,'editor.mjs'),bundle.outputFiles[0].contents);const{AnnotationEditor}=await import(pathToFileURL(join(temporary,'editor.mjs')).href),anchor={chatSessionId:'own-chat',environmentId:'own-env',workbenchTabId:'own-view',targetId:'own-target',appId:'own-app',kind:'browser',epoch:8,frameId:'own-frame',width:1280,height:720,imageSHA256:'a'.repeat(64),viewportVersion:'own-scroll',geometry:{x:0,y:0,width:1280,height:720,scale:1}},capture={anchor,imageBase64:'/9j/2Q==',mediaType:'image/jpeg'}
async function render(t,currentAnchor,extra=''){const dom=new JSDOM('<div id="own"></div>'+extra),saved=new Map();for(const[k,v]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){saved.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{value:v,writable:true,configurable:true})}const parent=dom.window.document.getElementById('own'),root=createRoot(parent);await React.act(async()=>root.render(React.createElement(AnnotationEditor,{capture,currentAnchor,onClose(){}})));t.after(async()=>{await React.act(async()=>root.unmount());dom.window.close();for(const[k,v]of saved)v?Object.defineProperty(globalThis,k,v):delete globalThis[k]});return{dom,parent}}
test.after(()=>rm(temporary,{recursive:true,force:true}))
test('actual production editor invalidation replaces child style feedback by parent stale alert',async t=>{const{parent}=await render(t,undefined);assert.equal(staleStyleSurfaceFacts(parent).refused,true);assert.equal(parent.querySelector('[aria-label="临时样式反馈"]'),null)})
test('same valid anchor or a foreign stale editor outside own root cannot falsely pass',async t=>{const{parent}=await render(t,anchor,'<section class="qyt-ann" aria-label="画面批注"><p role="alert">画面或当前聊天已变化，请关闭批注后重新打开。</p><button>关闭</button></section>');assert.equal(staleStyleSurfaceFacts(parent).refused,false)})
for(const kind of['duplicate','join-button','stale-child'])test('reject unsafe stale oracle '+kind,async t=>{const{parent,dom}=await render(t,undefined);if(kind==='duplicate')parent.append(parent.firstElementChild.cloneNode(true));if(kind==='join-button'){const b=dom.window.document.createElement('button');b.textContent='加入本次批注';parent.firstElementChild.append(b)}if(kind==='stale-child'){const e=dom.window.document.createElement('section');e.setAttribute('aria-label','临时样式反馈');parent.firstElementChild.append(e)}assert.equal(staleStyleSurfaceFacts(parent).refused,false)})
