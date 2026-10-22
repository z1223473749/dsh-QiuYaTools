import test from 'node:test'
import assert from 'node:assert/strict'
import {windowsVisionChildrenCommand,windowsVisionChildrenPassed} from '../scripts/live-vision-windows-children.mjs'
const path='C:\\own\\native.exe',identity={pid:42,parentPid:40,createdAtTicks:'639282542717808148',executablePath:path,sessionId:1}
const empty=()=>({version:1,scope:'one-live-native-direct-child-snapshot',coversShutdownChildren:false,coversRecursiveTree:false,nativePinned:true,nativeStillPinned:true,passed:true,stages:[{stage:'pin-native',passed:true},{stage:'enumerate-cim',passed:true,count:0},{stage:'recheck-native',passed:true}],candidates:[],failure:null})
test('a direct-child snapshot cannot turn an unknown, absent or changed native into an empty successful child list',()=>{
 assert.equal(windowsVisionChildrenPassed(empty(),identity,path),true)
 for(const patch of[{nativePinned:false},{nativeStillPinned:false},{passed:false},{failure:{stage:'pin-native',code:'NATIVE_PIN_UNCONFIRMED'}},{stages:[]},{scope:'whole-tree'},{coversShutdownChildren:true},{coversRecursiveTree:true},{candidates:null}])assert.equal(windowsVisionChildrenPassed({...empty(),...patch},identity,path),false)
})
test('each accepted direct child requires exact native executable, same session, parent and corroborated birth, while console or unknown children stay red',()=>{
 const value=empty(),child={pid:43,parentPid:42,createdAtTicks:'639282542717808149',sessionId:1,executablePath:path,cimBirthMatched:true,parentMatched:true,sessionMatched:true,pathClass:'native-executable'}
 value.candidates.push(child);value.stages[1].count=1;value.stages.splice(2,0,{stage:'pin-child',passed:true,pid:43},{stage:'classify-path',passed:true,pid:43,pathClass:'native-executable'});assert.equal(windowsVisionChildrenPassed(value,identity,path),true)
 for(const patch of[{parentPid:99},{sessionId:2},{createdAtTicks:'639282542717808147'},{pathClass:'system-console'},{pathClass:'other-executable'},{cimBirthMatched:false},{parentMatched:false},{sessionMatched:false},{executablePath:'C:\\Windows\\System32\\conhost.exe'}])assert.equal(windowsVisionChildrenPassed({...value,candidates:[{...child,...patch}]},identity,path),false)
 assert.equal(windowsVisionChildrenPassed({...value,candidates:[child,child],stages:[...value.stages.slice(0,1),{stage:'enumerate-cim',passed:true,count:2},...value.stages.slice(2)]},identity,path),false)
})
test('a canonical Microsoft-signed system console remains an owned child and requires every system-file and process proof',()=>{
 const value=empty();value.systemDirectory='C:\\Windows\\System32';const trust={systemDirectory:value.systemDirectory,systemDirectorySource:'Environment.SystemDirectory',systemRootMatched:true,systemPathMatched:true,reparsePoint:false,stable:true,fileSha256:'a'.repeat(64),signerSha256:'b'.repeat(64),bytes:1024,lastWriteTicks:'639282542717808148',signatureStatus:'Valid',microsoftPublisher:true}
 const child={pid:43,parentPid:42,createdAtTicks:'639282542717808149',sessionId:1,executablePath:'C:\\Windows\\System32\\conhost.exe',cimBirthMatched:true,parentMatched:true,sessionMatched:true,pathClass:'trusted-system-console',consoleTrust:trust};value.candidates=[child];value.stages[1].count=1;value.stages.splice(2,0,{stage:'pin-child',passed:true,pid:43},{stage:'classify-path',passed:true,pid:43,pathClass:'trusted-system-console'})
 assert.equal(windowsVisionChildrenPassed(value,identity,path),true)
 for(const patch of[{systemDirectorySource:'env-var'},{systemRootMatched:false},{systemPathMatched:false},{reparsePoint:true},{stable:false},{fileSha256:'bad'},{signerSha256:null},{bytes:0},{signatureStatus:'NotSigned'},{microsoftPublisher:false},{lastWriteTicks:'bad'},{systemDirectory:'C:\\fake\\System32'}])assert.equal(windowsVisionChildrenPassed({...value,candidates:[{...child,consoleTrust:{...trust,...patch}}]},identity,path),false)
 for(const patch of[{executablePath:'C:\\own\\conhost.exe'},{parentPid:99},{sessionId:2},{pathClass:'system-console'},{cimBirthMatched:false}])assert.equal(windowsVisionChildrenPassed({...value,candidates:[{...child,...patch}]},identity,path),false)
})
test('system console trust is produced by the same read-only process snapshot and never grants kill, input or broad executable adoption',()=>{
 const command=windowsVisionChildrenCommand(identity,path)
 assert.match(command,/\[Environment\]::SystemDirectory/u);assert.match(command,/SpecialFolder\]::Windows/u);assert.match(command,/Get-AuthenticodeSignature -LiteralPath \$console/u);assert.match(command,/\[IO.FileShare\]::Read/u);assert.match(command,/ReparsePoint/u);assert.match(command,/Get-FileHash.*SHA256/u);assert.match(command,/signatureStatus='Valid';microsoftPublisher=\$true/u)
 assert.doesNotMatch(command,/Stop-Process|\.Kill\(|SendInput|Get-AuthenticodeSignature.*Status.*Unknown/u)
})
test('the diagnostic command has four finite stages and read-only SafeHandle/CIM proof within a Windows command-line envelope',()=>{
 const command=windowsVisionChildrenCommand(identity,path)
 for(const stage of['pin-native','enumerate-cim','pin-child','classify-path'])assert.ok(command.includes(stage))
 assert.match(command,/SafeHandle/u);assert.match(command,/CreationDate.ToUniversalTime\(\).Ticks/u);assert.match(command,/\$birth%10/u);assert.match(command,/messageSHA256/u)
 assert.doesNotMatch(command,/SendInput|Stop-Process|\.Kill\(|SetForeground|CommandLine/u)
 assert.ok(Buffer.from(command,'utf16le').toString('base64').length<30000)
 assert.throws(()=>windowsVisionChildrenCommand({...identity,sessionId:0},path))
})
