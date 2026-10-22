import {win32} from 'node:path'
const hashPattern=/^[a-f0-9]{64}$/u
function defaults(rows){
 if(!Array.isArray(rows)||rows.length!==4)return null
 const names=['http','https','.htm','.html'],result=[]
 for(const name of names){const found=rows.filter(row=>row.association===name);if(found.length!==1)return null;const row=found[0]
  if(typeof row.exists!=='boolean'||(row.exists?typeof row.progId!=='string'||!row.progId||!hashPattern.test(row.hashSha256):row.progId!==null||row.hashSha256!==null))return null
  result.push({association:name,exists:row.exists,progId:row.progId,hashSha256:row.hashSha256})
 }return result
}
/** Recompute dependency install gates; success text alone is insufficient. */
export function assessChromeDependency(report,binding){
 const source=report?.source,pre=report?.preflight,exe=report?.postflight?.exe,installer=report?.installer
 const before=defaults(report?.defaults?.before),after=defaults(report?.defaults?.after)
 const defaultAssociationsUnchanged=Boolean(before&&after&&JSON.stringify(before)===JSON.stringify(after)&&report.defaults.unchanged===true)
 const installedNew=Boolean(pre?.chromeAbsent===true&&pre?.newApplicationDirectoryAbsent===true&&pre?.windowsARM64===true&&pre?.interactiveUserVerified===true&&pre?.interactiveSid===binding.interactiveSid&&pre?.registryScanCompleted===true&&Array.isArray(pre?.checkedCandidatePaths)&&pre.checkedCandidatePaths.length>=2&&Array.isArray(pre?.existingChromePaths)&&pre.existingChromePaths.length===0&&Array.isArray(pre?.registeredChrome)&&pre.registeredChrome.length===0&&report?.postflight?.newChrome===true)
 const verifiedSource=Boolean(source?.sha256===binding.msiSHA256&&source?.bytes===binding.msiBytes&&source?.signatureStatus==='Valid'&&source?.publisher==='Google LLC')
 const validExe=Boolean(exe?.signatureStatus==='Valid'&&exe?.publisher==='Google LLC'&&exe?.machine===0xaa64&&hashPattern.test(exe?.sha256)&&typeof exe?.version==='string'&&exe.version.trim()&&typeof exe?.path==='string'&&win32.normalize(exe.path).toLowerCase()===win32.normalize(binding.expectedExecutable).toLowerCase())
 const naturalInstallerExit=Boolean(installer?.started===true&&installer?.identityReceiptWritten===true&&installer?.identityPathMatched===true&&installer?.identitySessionMatched===true&&installer?.naturalExit===true&&installer?.exitCode===0&&installer?.identity?.pid>0&&/^\d+$/u.test(installer?.identity?.createdAtTicks)&&typeof installer?.identity?.executable==='string'&&win32.normalize(installer.identity.executable).toLowerCase()===win32.normalize(binding.expectedInstaller).toLowerCase()&&Number.isInteger(installer?.identity?.sessionId)&&installer.identity.sessionId>=0&&report?.cleanup?.installerHasExited===true)
 const observation=report?.googleUpdate
 const updaterObserved=Boolean(observation?.readSucceeded===true&&observation?.mutationsPerformed===false&&[observation?.before?.services,observation?.before?.tasks,observation?.after?.services,observation?.after?.tasks].every(Array.isArray))
 const noCleanupMutation=report?.cleanup?.processSignalsSent===false&&report?.cleanup?.taskStopsSent===false
 const errorsAbsent=Array.isArray(report?.errors)&&report.errors.length===0
 return{passed:Boolean(report?.passed===true&&report?.architecture==='ARM64'&&verifiedSource&&installedNew&&validExe&&naturalInstallerExit&&defaultAssociationsUnchanged&&updaterObserved&&noCleanupMutation&&errorsAbsent),verifiedSource,installedNew,validExe,naturalInstallerExit,defaultAssociationsUnchanged,updaterObserved,noCleanupMutation,errorsAbsent}
}
