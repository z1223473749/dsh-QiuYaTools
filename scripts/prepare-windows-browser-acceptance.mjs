/** Zero-PD preparation; copies and verifies the complete browser test closure. */
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { build } from 'esbuild'
const repository=fileURLToPath(new URL('../',import.meta.url)),id=randomUUID()
const arg=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1]}
const browser=arg('--browser')??'all';assert.ok(['chrome','edge','all'].includes(browser),'--browser must be chrome, edge or all')
const base=join(repository,'artifacts/computer-use/windows-browser-prepared-'+browser+'-'+id),snapshot=join(base,'snapshot')
await mkdir(snapshot,{recursive:true})
const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),sourceHashes={},expected={},paths={},carrierHashes={}
const module=await build({stdin:{contents:'export { BrowserSession, BrowserDeviceDriver } from "./src/features/computer-use/browser.ts";export { ComputerSessionService } from "./src/features/computer-use/session.ts";export { installComputerTools } from "./src/features/computer-use/tools.ts";',resolveDir:repository,sourcefile:'browser-test-entry.ts'},absWorkingDir:repository,bundle:true,write:false,platform:'node',format:'esm',metafile:true})
for(const name of Object.keys(module.metafile.inputs).filter(name=>name!=='browser-test-entry.ts'))sourceHashes[name]=sha(await readFile(join(repository,name)))
const own=['scripts/prepare-windows-browser-acceptance.mjs','scripts/windows-browser-carrier.mjs','scripts/windows-browser-transport.mjs','scripts/windows-browser-evidence.mjs','scripts/test-computer-browser.mjs','tests/fixtures/windows-browser-guest.mjs','tests/fixtures/windows-browser-run.ps1','tests/windows-browser-acceptance.test.mjs']
for(const name of own)sourceHashes[name]=sha(await readFile(join(repository,name)))
const content={'module.mjs':module.outputFiles[0].contents,'smoke.mjs':await readFile(join(repository,'scripts/test-computer-browser.mjs')),'guest.mjs':await readFile(join(repository,'tests/fixtures/windows-browser-guest.mjs')),'run.ps1':await readFile(join(repository,'tests/fixtures/windows-browser-run.ps1'))}
for(const [name,bytes]of Object.entries(content)){await writeFile(join(snapshot,name),bytes);expected[name]=sha(bytes);paths[name]='snapshot/'+name}
// esbuild resolves literal static/dynamic imports recursively, including the smoke's
// module import; this does not execute guest guards, launch browsers or call PD.
const graph=await build({entryPoints:[join(snapshot,'guest.mjs')],absWorkingDir:base,bundle:true,write:false,packages:'external',platform:'node',format:'esm',metafile:true})
const included=Object.keys(graph.metafile.inputs)
for(const name of ['snapshot/guest.mjs','snapshot/smoke.mjs','snapshot/module.mjs'])assert.ok(included.includes(name),'Snapshot import omitted: '+name)
const snapshotImportSmoke={passed:true,resolved:included.filter(name=>name.startsWith('snapshot/')),method:'esbuild-full-literal-module-closure',pdCommandsExecuted:0,browsersLaunched:0}
await writeFile(join(base,'snapshot-import-smoke.json'),JSON.stringify(snapshotImportSmoke,null,2))
for(const name of ['windows-browser-transport.mjs','windows-browser-evidence.mjs']){const bytes=await readFile(join(repository,'scripts',name));await writeFile(join(base,name),bytes);carrierHashes[name]=sha(bytes)}
const entry=await readFile(join(repository,'scripts/windows-browser-carrier.mjs'));await writeFile(join(base,'entry.mjs'),entry)
const data={id,browser,repository,preparedAt:new Date().toISOString(),entrySHA256:sha(entry),sourceHashes,carrierHashes,expected,paths,snapshotImportSmoke,vm:'ffba3614-b0e4-4b38-b185-b9a4b7ba5aec',host:'10.211.55.2',prl:'/Applications/Parallels Desktop.app/Contents/MacOS/prlctl',cachedNode:'C:\\Users\\qiuya\\AppData\\Local\\Temp\\QiuYaTools-harness-e37c617e-2126-4238-b36b-7c66f8cdb6b3\\node-v22.23.3-win-arm64\\node.exe',cachedNodeSHA256:'b5a3165ec6f24c0b1fe2a10fed58e03f6c1d7d141beb3b225ff030ceac6c5eb5',output:'/Users/qiuya/QiuYaTools-验收/2026-10-22/原始截图/Windows-browser-'+browser+'-'+id,actualBrowser:false,actualOsDesktopInput:false,realModelInference:false,pdCommandsExecuted:false}
await writeFile(join(base,'prepare-data.json'),JSON.stringify(data,null,2))
console.log(JSON.stringify({entry:join(base,'entry.mjs'),browser,output:data.output,snapshotImportSmoke,sourceCount:Object.keys(sourceHashes).length,executed:false},null,2))
