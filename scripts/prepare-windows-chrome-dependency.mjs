/** Prepare only. Actual installation requires a root-assigned PD slot. */
import assert from 'node:assert/strict'
import{readFile,writeFile,mkdir,stat,realpath}from'node:fs/promises'
import{createReadStream}from'node:fs'
import{join,basename,dirname}from'node:path'
import{fileURLToPath}from'node:url'
import{createHash,randomUUID}from'node:crypto'
import{build}from'esbuild'
const repository=fileURLToPath(new URL('../',import.meta.url)),arg=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1]}
assert.ok(arg('--download-receipt'),'--download-receipt is required')
const receiptPath=await realpath(arg('--download-receipt')),receipt=JSON.parse(await readFile(receiptPath,'utf8')),msi=await realpath(receipt.msi)
assert.equal(receipt.url,'https://dl.google.com/dl/chrome/install/GoogleChromeStandaloneEnterprise_Arm64.msi');assert.equal(receipt.passed,true);assert.equal(receipt.httpStatus,200);assert.equal(receipt.tlsVerified,true);assert.equal(receipt.redirects,0);assert.equal(receipt.architectureExpected,'ARM64')
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),h=createHash('sha256');for await(const bytes of createReadStream(msi))h.update(bytes)
const msiSHA256=h.digest('hex'),msiBytes=(await stat(msi)).size;assert.equal(msiSHA256,receipt.sha256);assert.equal(msiBytes,receipt.bytes)
const id=randomUUID(),base=join(repository,'artifacts/computer-use/windows-chrome-dependency-prepared-'+id),snapshot=join(base,'snapshot'),sourceHashes={},frozenHashes={}
await mkdir(snapshot,{recursive:true})
const graph=await build({entryPoints:[join(repository,'scripts/windows-chrome-dependency-carrier.mjs')],absWorkingDir:repository,bundle:true,write:false,packages:'external',platform:'node',format:'esm',metafile:true})
const names=Object.keys(graph.metafile.inputs),copied=new Set()
for(const name of names){assert.ok(name.startsWith('scripts/')&&!name.includes('..'));sourceHashes[name]=hash(await readFile(join(repository,name)));if(name==='scripts/windows-chrome-dependency-carrier.mjs')continue;const dest=basename(name);assert.ok(!copied.has(dest));copied.add(dest);const bytes=await readFile(join(repository,name));await writeFile(join(base,dest),bytes);frozenHashes[dest]=hash(bytes)}
for(const name of ['scripts/prepare-windows-chrome-dependency.mjs','tests/fixtures/windows-chrome-dependency.ps1','tests/windows-chrome-dependency.test.mjs'])sourceHashes[name]=hash(await readFile(join(repository,name)))
const fixture=await readFile(join(repository,'tests/fixtures/windows-chrome-dependency.ps1'));await writeFile(join(snapshot,'install.ps1'),fixture);frozenHashes['snapshot/install.ps1']=hash(fixture)
const entry=await readFile(join(repository,'scripts/windows-chrome-dependency-carrier.mjs'));await writeFile(join(base,'entry.mjs'),entry)
const data={id,repository,preparedAt:new Date().toISOString(),entrySHA256:hash(entry),sourceHashes,frozenHashes,snapshotImportSmoke:{passed:true,method:'esbuild-complete-carrier-import-closure',inputs:names,pdCommandsExecuted:0},msi,msiSHA256,msiBytes,downloadReceipt:receiptPath,downloadReceiptSHA256:hash(await readFile(receiptPath)),vm:'ffba3614-b0e4-4b38-b185-b9a4b7ba5aec',host:'10.211.55.2',prl:'/Applications/Parallels Desktop.app/Contents/MacOS/prlctl',output:'/Users/qiuya/QiuYaTools-验收/2026-10-22/原始截图/Windows-Chrome-依赖安装-'+id,validityDeadline:null}
await writeFile(join(base,'prepare-data.json'),JSON.stringify(data,null,2));console.log(JSON.stringify({entry:join(base,'entry.mjs'),output:data.output,msiSHA256,msiBytes,sourceCount:Object.keys(sourceHashes).length,importSmoke:data.snapshotImportSmoke,installed:false,pdCommandsExecuted:0},null,2))
