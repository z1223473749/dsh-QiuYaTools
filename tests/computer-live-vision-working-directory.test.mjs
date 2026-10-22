import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,realpath,rm,stat,mkdir,symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {WorkingDirectoryService} from '@deepseek-ai/dsh-working-directory'
import {prepareVisionWorkingDirectory} from '../scripts/live-vision-working-directory.mjs'
export const inspectAgentCwd=async cwd=>WorkingDirectoryService.prototype.directory.call({ctx:{fs:{resolve:async path=>path,async stat(path){try{const info=await stat(path);return{type:info.isDirectory()?'directory':'file'}}catch(error){if(error.code==='ENOENT')return null;throw error}},processPath:path=>path}}},cwd,cwd,AbortSignal.timeout(1000))
test('the actual SDK Agent working-directory guard rejects the missing former Windows cwd and accepts the freshly verified directory',async t=>{
 const directory=await realpath(await mkdtemp(join(tmpdir(),'qiuya-vision-cwd-')));t.after(()=>rm(directory,{recursive:true,force:true}));const sid='qiuya-vision-'+randomUUID(),cwd=join(directory,'runtime',sid)
 await assert.rejects(inspectAgentCwd(cwd),/working-directory: directory does not exist/u)
 const proof=await prepareVisionWorkingDirectory(directory,sid);assert.equal(proof.cwd,cwd);assert.equal(proof.canonical,cwd);assert.equal(await inspectAgentCwd(proof.cwd),cwd);assert.equal((await stat(cwd)).isDirectory(),true)
 await assert.rejects(prepareVisionWorkingDirectory(directory,sid),{code:'EEXIST'})
})
test('a symlinked runtime cannot redirect creation outside the owned round',async t=>{
 const directory=await realpath(await mkdtemp(join(tmpdir(),'qiuya-vision-cwd-link-')));t.after(()=>rm(directory,{recursive:true,force:true}));const elsewhere=join(directory,'elsewhere');await mkdir(elsewhere);await symlink(elsewhere,join(directory,'runtime'))
 await assert.rejects(prepareVisionWorkingDirectory(directory,'qiuya-vision-'+randomUUID()),{code:'VISION_WORKING_DIRECTORY_BOUNDARY'})
})
test('foreign session IDs and relative roots cannot create Agent working directories',async()=>{
 for(const [directory,sid]of[['relative','qiuya-vision-'+randomUUID()],['/private/tmp','foreign-session'],['/private/tmp','../outside']])await assert.rejects(prepareVisionWorkingDirectory(directory,sid),{code:'VISION_WORKING_DIRECTORY_BOUNDARY'})
})
