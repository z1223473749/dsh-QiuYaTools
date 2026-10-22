/** Build and import-smoke complete test-only relay bundles. No VM, GUI or network. */
import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join, relative, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { builtinModules } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const sha=b=>createHash('sha256').update(b).digest('hex'),exec=promisify(execFile)
const repository=fileURLToPath(new URL('../',import.meta.url)),builtins=new Set(builtinModules.flatMap(x=>[x,'node:'+x]))
export async function prepareWindowsVisionCarrier({output}){
 const directory=resolve(output);await mkdir(directory,{recursive:false})
 const sourceBytes=new Map(),sources={},results={},smoke=[]
 const auditSource='tests/fixtures/windows-remote-audit.cs',auditBytes=await readFile(join(repository,auditSource)),auditSha256=sha(auditBytes)
 sourceBytes.set(auditSource,auditBytes);await writeFile(join(directory,'windows-remote-audit.cs'),auditBytes)
 for(const[name,entry]of[['windows-carrier.mjs','scripts/live-vision-windows-carrier.mjs'],['windows-guest.mjs','scripts/live-vision-windows-guest.mjs'],['windows-cancel-smoke.mjs','scripts/test-windows-vision-cancel.mjs']]){
  const result=await build({entryPoints:[join(repository,entry)],absWorkingDir:repository,bundle:true,write:false,platform:'node',format:'esm',target:'node22',metafile:true,plugins:[{name:'freeze-source-closure',setup(api){api.onLoad({filter:/\.(ts|mjs)$/},async({path})=>{
   const key=relative(repository,path);if(key.startsWith('..')||key.startsWith('/'))throw Error('Relay source outside repository')
   const bytes=await readFile(path),previous=sourceBytes.get(key);if(previous&&sha(previous)!==sha(bytes))throw Error('Relay source changed during bundle: '+key)
   sourceBytes.set(key,bytes);return{contents:bytes,loader:path.endsWith('.ts')?'ts':'js'}
  })}}]})
  for(const input of Object.keys(result.metafile.inputs))if(!sourceBytes.has(input))throw Error('Uncaptured static import: '+input)
  for(const output of Object.values(result.metafile.outputs))for(const item of output.imports)if(!item.external||!builtins.has(item.path))throw Error('Unbundled non-builtin import: '+item.path)
  await writeFile(join(directory,name),result.outputFiles[0].contents);results[name]=sha(result.outputFiles[0].contents)
  const checked=await exec(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(pathToFileURL(join(directory,name)).href)});process.stdout.write('import-ok\\n')`],{timeout:15000,maxBuffer:32768})
  if(checked.stdout!=='import-ok\n'||checked.stderr)throw Error('Relay bundle import smoke failed: '+name)
  smoke.push({file:name,status:'passed',actualImport:true,windowsExecution:false})
 }
 for(const[input,bytes]of sourceBytes){
  if(sha(await readFile(join(repository,input)))!==sha(bytes))throw Error('Relay source drifted before freeze: '+input)
  const destination=join(directory,'source-snapshot',input);await mkdir(dirname(destination),{recursive:true});await writeFile(destination,bytes);sources[input]=sha(bytes)
 }
 const manifest={version:1,kind:'test-only-Windows-outbound-reverse-relay',guestSha256:results['windows-guest.mjs'],carrierSha256:results['windows-carrier.mjs'],cancelSmokeSha256:results['windows-cancel-smoke.mjs'],auditSha256,sourceHashes:sources,sourceClosureComplete:true,nonBuiltinImportsBundled:true,importSmoke:smoke,accountCredentialsTransferred:false,windowsInboundPortOpened:false,preparedOnly:true,actualWindowsExecution:false,actualModelInference:false}
 await writeFile(join(directory,'windows-carrier-manifest.json'),JSON.stringify(manifest,null,2)+'\n')
 return {...manifest,carrier:join(directory,'windows-carrier.mjs'),guest:join(directory,'windows-guest.mjs'),directory}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){const i=process.argv.indexOf('--output');if(i<0||!process.argv[i+1])throw Error('Pass a fresh --output directory');console.log(JSON.stringify(await prepareWindowsVisionCarrier({output:process.argv[i+1]}),null,2))}
