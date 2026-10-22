/** Freeze a new cleanup-only driver/binding; never invokes CLI, Host, PD or model. */
import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve, relative, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { builtinModules } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { captureActivatedVisionFailure } from './live-vision-activated-remove.mjs'
import { writePrivateJSON, visionDigest } from './live-vision-external-core.mjs'
const root=fileURLToPath(new URL('../',import.meta.url)),exec=promisify(execFile)
export async function prepareVisionFailedRemoval({prepared,output}){
 const binding=await captureActivatedVisionFailure(resolve(prepared)),directory=resolve(output);if(directory===binding.directory)throw Error('Use a fresh cleanup subdirectory')
 await mkdir(directory,{mode:0o700});const sources=new Map(),builtins=new Set(builtinModules.flatMap(n=>[n,'node:'+n]))
 const result=await build({entryPoints:[join(root,'scripts/live-vision-official-cli.mjs')],absWorkingDir:root,bundle:true,write:false,platform:'node',format:'esm',target:'node22',metafile:true,plugins:[{name:'freeze-cleanup-driver',setup(api){api.onLoad({filter:/\.mjs$/},async({path})=>{const key=relative(root,path);if(key.startsWith('..')||key.startsWith('/'))throw Error('Cleanup source boundary');const bytes=await readFile(path);sources.set(key,bytes);return{contents:bytes,loader:'js'}})}}]})
 for(const input of Object.keys(result.metafile.inputs))if(!sources.has(input))throw Error('Unfrozen cleanup import')
 for(const out of Object.values(result.metafile.outputs))for(const item of out.imports)if(!item.external||!builtins.has(item.path))throw Error('Unbundled cleanup import')
 const driver=join(directory,'official-cli-failed-remove.mjs');await writeFile(driver,result.outputFiles[0].contents,{mode:0o600});await writePrivateJSON(join(directory,'cleanup-binding.json'),binding)
 const sourceHashes={};for(const [path,bytes]of sources){if(visionDigest(await readFile(join(root,path)))!==visionDigest(bytes))throw Error('Cleanup source changed');const destination=join(directory,'source-snapshot',path);await mkdir(dirname(destination),{recursive:true,mode:0o700});await writeFile(destination,bytes,{mode:0o600});sourceHashes[path]=visionDigest(bytes)}
 const smoke=await exec(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(pathToFileURL(driver).href)});process.stdout.write('import-ok')`],{timeout:10000,maxBuffer:32768});if(smoke.stdout!=='import-ok'||smoke.stderr)throw Error('Cleanup driver import smoke failed')
 const command={executable:process.execPath,args:[driver,'--prepared',binding.directory,'--mode','activated-failed-remove','--recovery-binding',join(directory,'cleanup-binding.json'),'--root-approved']}
 const manifest={version:1,kind:'activated-failed-removal-preparation',runId:binding.runId,manifestSHA:binding.manifestSHA,driverSha256:visionDigest(result.outputFiles[0].contents),bindingSha256:visionDigest(JSON.stringify(binding)),sourceHashes,sourceClosureComplete:true,actualStandaloneImport:true,CLIInvoked:false,HostInvoked:false,PDInvoked:false,modelInference:false,capExpiryBypassedForInference:false,cleanupMayUseExpiredInferenceCap:true,expectedSuccessStatus:'removed-restoration-unconfirmed',expectedExitCode:1,command}
 await writePrivateJSON(join(directory,'preparation.json'),manifest);return manifest
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){const arg=k=>process.argv[process.argv.indexOf(k)+1];prepareVisionFailedRemoval({prepared:arg('--prepared'),output:arg('--output')}).then(v=>console.log(JSON.stringify(v))).catch(e=>{console.error(e.code??'VISION_CLI_FAILED_REMOVE_PREPARATION');process.exitCode=1})}
