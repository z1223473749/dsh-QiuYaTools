import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { windowsVisionPinFunction, windowsVisionPinCommand, windowsVisionDesktopCommand, windowsVisionDesktopPassed } from '../scripts/live-vision-windows-audit.mjs'
test('initialization reuses the C# same-handle birth/CIM policy with bounded wait only and retained samples', async()=>{
 const policy=await readFile(new URL('./fixtures/windows-remote-audit.cs',import.meta.url),'utf8')
 assert.match(policy,/public static string BindingDecision/u)
 assert.match(windowsVisionPinFunction,/\$null=\$process.SafeHandle;\$originalBirth=/u)
 assert.equal((windowsVisionPinFunction.match(/GetProcessById/gu)??[]).length,0)
 assert.match(windowsVisionPinFunction,/ElapsedMilliseconds-le 4000/u)
 assert.match(windowsVisionPinFunction,/\[QytRemoteAudit\]::BindingDecision\(/u)
 assert.match(windowsVisionPinFunction,/if\(\$decision-eq 'reject'\)\{throw/u)
 assert.match(windowsVisionPinFunction,/\$stable-ge 2/u)
 assert.match(windowsVisionPinFunction,/samples=@\(\$samples.ToArray\(\)\)/u)
 assert.doesNotMatch(windowsVisionPinFunction,/Kill\(|Stop-Process|SendInput|SetForeground/u)
 const command=windowsVisionPinCommand({pid:42,path:'C:\\own\\native.exe',parentPid:40,parentBirth:'639282542717808148',sessionId:1,auditPath:'C:\\own\\windows-remote-audit.cs',auditSha256:'a'.repeat(64)})
 assert.match(command,/Get-FileHash.*SHA256/u);assert.match(command,/finally\{if\(\$p\)\{\$p.Dispose\(\)\}\}/u)
 assert.throws(()=>windowsVisionPinCommand({pid:42,path:'C:\\own\\native.exe',sessionId:0,auditSha256:'a'.repeat(64)}))
})
test('independent release audit uses only existing read-only Snapshot and cannot accept missing scope, held input or another desktop',async()=>{
 const options={sessionId:1,auditSha256:'a'.repeat(64)},value={phase:'after-owned-native-fixture-exit',auditSourceSha256:options.auditSha256,sessionId:1,userInteractive:true,activeDesktopAccessible:true,activeDesktopMatches:true,heldKeyCount:0,leaseScopeExists:true,leaseFree:true,journalPresent:false}
 assert.equal(windowsVisionDesktopPassed(value,options),true)
 for(const patch of[{sessionId:2},{leaseScopeExists:false},{heldKeyCount:1},{journalPresent:true},{leaseFree:false},{activeDesktopMatches:false},{auditSourceSha256:'b'.repeat(64)},{phase:'before-release'}])assert.equal(windowsVisionDesktopPassed({...value,...patch},options),false)
 for(const key of Object.keys(value))assert.equal(windowsVisionDesktopPassed(Object.fromEntries(Object.entries(value).filter(([k])=>k!==key)),options),false)
 const command=windowsVisionDesktopCommand('C:\\own\\windows-remote-audit.cs',options.auditSha256)
 assert.match(command,/\[QytRemoteAudit\]::Snapshot\(\)/u)
 assert.doesNotMatch(command,/SendInput|\.Kill\(|Stop-Process|desktop\.lock.*Create|owned-input\.json.*Delete/u)
 const guest=await readFile(new URL('../scripts/live-vision-windows-guest.mjs',import.meta.url),'utf8')
 assert.ok(guest.indexOf('const nativeNaturalExit=')<guest.indexOf('ps(windowsVisionDesktopCommand('))
 assert.match(guest,/desktopAudit:desktopAudit\?\?null/u)
})
