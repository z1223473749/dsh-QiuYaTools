import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const run=promisify(execFile)
test('privileged duplex transport routes replies, bypasses slow actions for release and waits for confirmed cleanup',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'qyt-elevated-transport-'))
 const dotnet=process.env.QIUYA_DOTNET||'dotnet'
 try {
  await run(dotnet,['build','tests/fixtures/windows-elevated-transport/Transport.csproj','-o',join(directory,'out'),`-p:BaseIntermediateOutputPath=${join(directory,'obj')}/`,'-p:NuGetAudit=false','--ignore-failed-sources','--nologo'],{timeout:90000})
  const result=JSON.parse((await run(dotnet,[join(directory,'out/Transport.dll')],{timeout:10000})).stdout)
  assert.equal(result.passed,true);assert.equal(result.actualOsInput,false);assert.equal(result.checks,8)
 } finally {await rm(directory,{recursive:true,force:true})}
},{timeout:120000})
