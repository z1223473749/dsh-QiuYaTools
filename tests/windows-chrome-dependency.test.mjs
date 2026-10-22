import test from'node:test'
import assert from'node:assert/strict'
import{execFile}from'node:child_process'
import{promisify}from'node:util'
import{readFile,writeFile,access}from'node:fs/promises'
import{join,dirname}from'node:path'
import{fileURLToPath}from'node:url'
import{assessChromeDependency}from'../scripts/windows-chrome-dependency-evidence.mjs'
const hash='a'.repeat(64),sid='S-1-5-21-123-456-789-1000',binding={msiSHA256:hash,msiBytes:174944256,interactiveSid:sid,expectedExecutable:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',expectedInstaller:'C:\\Windows\\System32\\msiexec.exe'}
function fixture(){const defaults=['http','https','.htm','.html'].map(association=>({association,exists:true,progId:'MSEdgeHTM',hashSha256:hash}));return{passed:true,architecture:'ARM64',source:{sha256:hash,bytes:binding.msiBytes,signatureStatus:'Valid',publisher:'Google LLC'},preflight:{chromeAbsent:true,newApplicationDirectoryAbsent:true,windowsARM64:true,interactiveUserVerified:true,interactiveSid:sid,registryScanCompleted:true,checkedCandidatePaths:['machine','user'],existingChromePaths:[],registeredChrome:[]},postflight:{newChrome:true,exe:{signatureStatus:'Valid',publisher:'Google LLC',machine:0xaa64,sha256:hash,version:'1.2.3.4',path:binding.expectedExecutable}},installer:{started:true,identityReceiptWritten:true,identityPathMatched:true,identitySessionMatched:true,naturalExit:true,exitCode:0,identity:{pid:42,createdAtTicks:'12345',executable:binding.expectedInstaller,sessionId:0}},defaults:{before:structuredClone(defaults),after:structuredClone(defaults),unchanged:true},googleUpdate:{readSucceeded:true,mutationsPerformed:false,before:{services:[],tasks:[]},after:{services:[{name:'GoogleUpdater-new'}],tasks:[]}},cleanup:{installerHasExited:true,processSignalsSent:false,taskStopsSent:false},errors:[]}}
test('strict new ARM64 Chrome install permits observed updater additions without cleanup mutations',()=>{assert.equal(assessChromeDependency(fixture(),binding).passed,true)})
test('default association changes, missing scope or fake unchanged flag cannot pass',()=>{
 for(const mutate of [r=>r.defaults.after[0].progId='ChromeHTML',r=>r.defaults.before.pop(),r=>r.defaults.after[0].hashSha256='b'.repeat(64),r=>r.preflight.interactiveSid='S-1-5-18',r=>r.defaults.unchanged=false]){const r=fixture();mutate(r);assert.equal(assessChromeDependency(r,binding).passed,false)}
})
test('existing Chrome, untrusted package, x64 exe, restart-needed or forced cleanup remain failures',()=>{
 for(const mutate of [r=>r.preflight.existingChromePaths.push('existing'),r=>r.preflight.registeredChrome.push({kind:'existing'}),r=>r.preflight.chromeAbsent=false,r=>r.source.publisher='Other',r=>r.source.signatureStatus='UnknownError',r=>r.source.sha256='b'.repeat(64),r=>r.postflight.exe.machine=0x8664,r=>r.postflight.exe.path='C:\\foreign\\chrome.exe',r=>r.installer.exitCode=3010,r=>r.installer.naturalExit=false,r=>r.installer.identityPathMatched=false,r=>r.installer.identitySessionMatched=false,r=>r.installer.identityReceiptWritten=false,r=>r.cleanup.processSignalsSent=true,r=>r.googleUpdate.mutationsPerformed=true]){const r=fixture();mutate(r);assert.equal(assessChromeDependency(r,binding).passed,false)}
})
test('explicitly absent defaults are comparable; unreadable or malformed UserChoice is not',()=>{
 const r=fixture();for(const rows of [r.defaults.before,r.defaults.after])for(const row of rows){row.exists=false;row.progId=null;row.hashSha256=null}assert.equal(assessChromeDependency(r,binding).passed,true)
 r.defaults.after[0].exists='unknown';assert.equal(assessChromeDependency(r,binding).passed,false)
})
test('prepare/plan validates downloaded package, full import closure and immutable dependency hashes with zero PD',async t=>{
 const receipt='/private/tmp/qiuya-chrome-official-arm64-e6451d3d-c800-4af2-9700-ed60e94625c9/download-receipt.json'
 try{await access(receipt)}catch{t.skip('Explicit official package preparation fixture unavailable');return}
 const execute=promisify(execFile),root=fileURLToPath(new URL('../',import.meta.url))
 const made=JSON.parse((await execute(process.execPath,['scripts/prepare-windows-chrome-dependency.mjs','--download-receipt',receipt],{cwd:root,timeout:30000})).stdout);assert.equal(made.pdCommandsExecuted,0);assert.equal(made.importSmoke.passed,true)
 const plan=JSON.parse((await execute(process.execPath,[made.entry,'--plan'],{cwd:root,timeout:30000})).stdout);assert.equal(plan.pdCommandsExecuted,0);assert.equal(plan.installed,false);assert.equal(plan.validityDeadline,null)
 const file=join(dirname(made.entry),'windows-chrome-dependency-evidence.mjs'),old=await readFile(file)
 try{await writeFile(file,Buffer.concat([old,Buffer.from('\n// tamper\n')]));await assert.rejects(execute(process.execPath,[made.entry,'--plan'],{cwd:root,timeout:30000}),/Frozen installer carrier changed/)}finally{await writeFile(file,old)}
})

test('installer identity mismatch retains failed verdict even after the same owned child naturally exits',()=>{
 const r=fixture();r.passed=false;r.errors.push('Owned MSI process path/session mismatch');r.installer.identityPathMatched=false
 const v=assessChromeDependency(r,binding);assert.equal(v.passed,false);assert.equal(v.naturalInstallerExit,false);assert.equal(r.cleanup.installerHasExited,true)
})
