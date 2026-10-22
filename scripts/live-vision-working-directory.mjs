/** A fresh owned Agent cwd. Does not launch a Host, fixture, model or process. */
import { mkdir, lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
const fail=()=>{throw Object.assign(Error('VISION_WORKING_DIRECTORY_BOUNDARY'),{code:'VISION_WORKING_DIRECTORY_BOUNDARY'})}
export async function prepareVisionWorkingDirectory(directory,sessionId){
 if(!isAbsolute(directory)||!/^qiuya-vision-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(sessionId))fail()
 const canonical=await realpath(directory),runtime=join(directory,'runtime'),cwd=join(runtime,sessionId)
 try{await mkdir(runtime,{mode:0o700})}catch(error){if(error.code!=='EEXIST')throw error}
 const parent=await lstat(runtime)
 if(!parent.isDirectory()||parent.isSymbolicLink()||await realpath(runtime)!==join(canonical,'runtime'))fail()
 await mkdir(cwd,{mode:0o700})
 const info=await lstat(cwd),path=await realpath(cwd)
 if(!info.isDirectory()||info.isSymbolicLink()||path!==join(canonical,'runtime',sessionId)||typeof process.getuid==='function'&&info.uid!==process.getuid())fail()
 return{cwd:resolve(cwd),canonical:path,created:true,directory:true}
}
