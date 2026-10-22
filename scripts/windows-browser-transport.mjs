import { randomUUID, createHash } from 'node:crypto'
import { win32 } from 'node:path'
const quote=value=>`'${value.replaceAll("'","''")}'`
export const encodedLength=code=>Buffer.from(code,'utf16le').toString('base64').length
// The only two Windows invocation modes: reviewed short EncodedCommand or SHA-verified own File.
export function createPowerShellTransport({invoke,files,url,receipt=async()=>{},uuid=randomUUID}) {
 const encoded=async (code,timeout,maxBuffer)=>{
  const payload=Buffer.from(code,'utf16le').toString('base64')
  if(payload.length>=2000)throw new Error('Inline diagnostic command exceeds strict <2000 envelope')
  return invoke(['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',payload],{timeout,maxBuffer})
 }
 return async function powershell(code,timeout=30000,maxBuffer=4*1024*1024) {
  if(encodedLength(code)<2000)return encoded(code,timeout,maxBuffer)
  const id=uuid(),name=`command-${id}.ps1`,folder=`QiuYaTools-capture-command-${id}`
  if(!/^[a-f0-9-]{36}$/u.test(id))throw new Error('Invalid own command UUID')
  const bytes=Buffer.from('\uFEFF'+code,'utf8')
  if(bytes.length>131072)throw new Error('Diagnostic command file exceeds bound')
  const digest=createHash('sha256').update(bytes).digest('hex')
  files.set(name,bytes)
  let binding
  const bootstrap=`$ErrorActionPreference='Stop';$d=Join-Path ([IO.Path]::GetTempPath()) ${quote(folder)};if(Test-Path -LiteralPath $d){throw 'exists'};[void][IO.Directory]::CreateDirectory($d);$p=Join-Path $d 'command.ps1';$w=[Net.WebClient]::new();$w.Proxy=$null;$w.DownloadFile(${quote(url(name))},$p);if((Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()-cne '${digest}'){throw 'SHA'};@{directory=$d;file=$p}|ConvertTo-Json -Compress`
  try {
   if(encodedLength(bootstrap)>=2000)throw new Error('Long command bootstrap exceeds strict <2000 envelope')
   await receipt({id,name,sha256:digest,bytes:bytes.length,bootstrapEncodedLength:encodedLength(bootstrap),executionMode:'File',ownTempFolder:folder})
   const response=await encoded(bootstrap,timeout,maxBuffer)
   binding=JSON.parse(response.replace(/^\uFEFF/u,''))
   if(!binding||!win32.isAbsolute(binding.directory)||binding.directory.startsWith('\\\\')||win32.basename(binding.directory)!==folder||win32.dirname(binding.file)!==binding.directory||win32.basename(binding.file)!=='command.ps1'||binding.file.length>500)throw new Error('Own command path binding changed')
   return await invoke(['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',binding.file],{timeout,maxBuffer})
  }finally{
   files.delete(name)
   if(binding?.directory&&binding?.file&&win32.basename(binding.directory)===folder&&win32.dirname(binding.file)===binding.directory&&win32.basename(binding.file)==='command.ps1') {
    const cleanup=`$ErrorActionPreference='Stop';$p=${quote(binding.file)};if((Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()-cne '${digest}'){throw 'SHA'};Remove-Item -LiteralPath $p -Force;[IO.Directory]::Delete(${quote(binding.directory)})`
    try{await encoded(cleanup,timeout,maxBuffer);await receipt({id,cleanupVerified:true,executionMode:'File',sha256:digest})}catch{await receipt({id,cleanupVerified:false,executionMode:'File',sha256:digest})}
   }
  }
 }
}
