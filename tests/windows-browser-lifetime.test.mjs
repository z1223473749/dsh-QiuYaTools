import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {spawn} from 'node:child_process'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
const hash=value=>createHash('sha256').update(value).digest('hex')
const xml=value=>value.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;')
async function execute(command,args,options){
 const child=spawn(command,args,{...options,stdio:['ignore','pipe','pipe']});let output='',errors=''
 child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8')
 child.stdout.on('data',value=>{output+=value});child.stderr.on('data',value=>{errors+=value})
 const result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}))})
 assert.equal(result.signal,null,'Pure C# process must finish naturally\n'+errors+'\n'+output)
 assert.equal(result.code,0,errors+'\n'+output)
 return output
}
test('real compiled product browser lifetime handles exact groups, initialization, normal close and bounded failure without GUI', {timeout:90000}, async t=>{
 const dotnet=process.env.QIUYA_DOTNET
 assert(dotnet,'Set QIUYA_DOTNET to the explicit .NET8 SDK executable for this no-GUI regression; no skipped acceptance')
 const source=fileURLToPath(new URL('../src/native/windows/BrowserExitState.cs',import.meta.url)),fixture=fileURLToPath(new URL('./fixtures/windows-browser-lifetime/Program.cs',import.meta.url)),windows=fileURLToPath(new URL('../src/native/windows/BrowserWindows.cs',import.meta.url))
 const before=[hash(await readFile(source)),hash(await readFile(fixture)),hash(await readFile(windows))]
 const temporary=await mkdtemp(join(tmpdir(),'qiuya-browser-lifetime-regression-'));t.after(()=>rm(temporary,{recursive:true,force:true}))
 const project=join(temporary,'BrowserLifetime.csproj'),config=join(temporary,'NuGet.Config')
 // Compile the real product callback, rather than a second implementation of its identity fence.
 const handlers=(await readFile(windows,'utf8')).split('\n').filter(line=>line.trim().startsWith('window.FormClosed += (_, _) => { if (sessions.'))
 assert.equal(handlers.length,1,'The session FormClosed callback must have exactly one source anchor')
 const legacy='window.FormClosed += (_, _) => { if (sessions.GetValueOrDefault(id) == window) sessions.Remove(id); if (prepared == id) prepared = null; };'
 const callbacks=join(temporary,'SessionPreparationCallbacks.cs')
 await writeFile(callbacks,`namespace QiuYaTools.Windows; internal sealed partial class SessionPreparationControl { private void Attach(string id, TestWindow window) { ${handlers[0]} } private void AttachLegacy(string id, TestWindow window) { ${legacy} } }\n`)
 await writeFile(config,'<configuration><packageSources><clear /></packageSources></configuration>\n')
 await writeFile(project,`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable><TreatWarningsAsErrors>true</TreatWarningsAsErrors><EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup><ItemGroup><Compile Include="${xml(source)}" Link="BrowserExitState.cs"/><Compile Include="${xml(fixture)}" Link="Program.cs"/><Compile Include="${xml(callbacks)}"/></ItemGroup></Project>\n`)
 const options={cwd:temporary,env:{...process.env,DOTNET_CLI_HOME:join(temporary,'dotnet-home'),DOTNET_SKIP_FIRST_TIME_EXPERIENCE:'1',DOTNET_CLI_TELEMETRY_OPTOUT:'1',DOTNET_NOLOGO:'1'}}
 await execute(dotnet,['build',project,'--configuration','Release','--configfile',config,'--disable-build-servers','--nologo'],options)
 const value=JSON.parse((await execute(dotnet,[join(temporary,'bin/Release/net8.0/BrowserLifetime.dll')],options)).trim())
 assert.equal(value.passed,true);assert.equal(value.tests.length,19);assert(value.tests.every(row=>row.passed===true));assert.equal(new Set(value.tests.map(row=>row.name)).size,19)
 for(const name of ['legacy-form-dispose-is-not-browser-retirement-red-control','pending-creation-defers-view-disposal','different-browser-exit-never-retires-original','early-exact-exit-is-not-lost-after-browser-bind','unknown-initialization-fails-closed','still-alive-fails-original-bound-without-kill-or-extension','late-event-can-release-resources-but-does-not-change-prior-timeout','legacy-stale-close-clears-new-preparation-red-control','stale-canceled-window-close-keeps-new-preparation','same-session-replacement-remains-cancellable','current-window-close-clears-own-preparation','different-session-close-keeps-current-preparation'])assert(value.tests.some(row=>row.name===name))
 for(const key of ['GUI','Host','PD','model','input','nativeWindows'])assert.equal(value[key],0)
 assert.deepEqual([hash(await readFile(source)),hash(await readFile(fixture)),hash(await readFile(windows))],before,'Product and fixture source remain byte exact')
})
