import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
const run=promisify(execFile),root=fileURLToPath(new URL('../../',import.meta.url)),dotnet=process.env.QIUYA_DOTNET||'dotnet';let directory,layout,report
before(async()=>{
 const version=(await run(dotnet,['--version'],{timeout:15000,maxBuffer:4096})).stdout.trim();assert.equal(version,'8.0.426','Use the same pinned SDK as the production Windows companion')
 directory=await mkdtemp(join(tmpdir(),'qiuya-journal-file-test-'))
 const project=join(root,'tests/fixtures/windows-journal-file-matrix/Matrix.csproj'),output=join(directory,'out');await mkdir(output)
 await run(dotnet,['build',project,'-c','Release','-o',output,`-p:BaseIntermediateOutputPath=${join(directory,'obj')}/`,`-p:BaseOutputPath=${join(directory,'bin')}/`,'-p:NuGetAudit=false','--ignore-failed-sources','--nologo'],{timeout:90000,maxBuffer:1024*1024})
 const executable=join(output,'Matrix.dll'),invoke=async args=>JSON.parse((await run(dotnet,[executable,...args],{timeout:30000,maxBuffer:65536})).stdout)
 layout=await invoke(['--encode-layout']);report=await invoke([])
}, {timeout:120000})
after(async()=>{if(directory)await rm(directory,{recursive:true,force:true})})
function validate(bytes){
 const name=Buffer.from('C:\\QiuYaTools\\你好\\owned-input.json','utf16le');assert.equal(layout.nameOffset,20);assert.equal(bytes.length,20+name.length+2);assert.equal(bytes.readUInt32LE(0),3,'Do not bypass read-only attributes or other access gates');assert.deepEqual(bytes.subarray(4,16),Buffer.alloc(12));assert.equal(bytes.readUInt32LE(16),name.length,'FileNameLength excludes terminal NUL');assert.deepEqual(bytes.subarray(20,-2),name);assert.deepEqual(bytes.subarray(-2),Buffer.alloc(2),'FileName must remain NUL terminated')
}
function row(name){const values=report.rows.filter(r=>r.name===name);assert.equal(values.length,1);return values[0]}
test('actual production encoder emits the public ABI with exact UTF16 and terminal NUL',()=>validate(Buffer.from(layout.bytes,'base64')))
test('the ABI oracle rejects the old missing-NUL regression',()=>assert.throws(()=>validate(Buffer.from(layout.bytes,'base64').subarray(0,-2))))
test('the ABI oracle rejects counting the terminal NUL in FileNameLength',()=>{const b=Buffer.from(layout.bytes,'base64');b.writeUInt32LE(b.readUInt32LE(16)+2,16);assert.throws(()=>validate(b))})
test('the ABI oracle rejects relaxing the read-only attribute gate',()=>{const b=Buffer.from(layout.bytes,'base64');b.writeUInt32LE(0x43,0);assert.throws(()=>validate(b))})
test('actual Write+Flush(true)+Move initial publication has exact new bytes',()=>{const r=row('move-first');assert.equal(r.success,true);assert.equal(r.currentSHA256,report.newSHA256)})
test('actual initial File.Replace-or-create baseline has exact new bytes',()=>{const r=row('replace-first');assert.equal(r.success,true);assert.equal(r.currentSHA256,report.newSHA256)})
test('actual old Move directory conflict retains the durable prepared file',()=>{const r=row('move-directory');assert.equal(r.success,false);assert.equal(r.expectedRejection,true);assert.equal(r.durableSourceRetained,true)})
test('actual baseline Replace directory conflict retains the durable prepared file',()=>{const r=row('replace-directory');assert.equal(r.success,false);assert.equal(r.expectedRejection,true);assert.equal(r.durableSourceRetained,true)})
test('the file-only process naturally retired, cleaned itself, and never touched GUI/HID/production leases',()=>{assert.equal(report.failure,null);assert.equal(report.ownTemporaryCleaned,true);assert.equal(report.windowsMatrixExecuted,process.platform==='win32');for(const k of ['nativeInputCalls','guiCalls','captureCalls','signals','productionLeaseAccesses','retries'])assert.equal(report[k],0);if(process.platform==='win32'){for(const name of ['posix-first','posix-read-delete','posix-readwrite-delete'])assert.equal(row(name).success,true);assert.equal(row('posix-read-only').success,false);assert.equal(row('posix-read-only').nativeError,32);assert.equal(row('posix-concurrent').succeeded,64);assert.equal(row('posix-concurrent').invalidPartialRecords,0)}})
