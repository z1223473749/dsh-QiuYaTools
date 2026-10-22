/** Test-only direct-child diagnostic. Unknown identity remains a cleanup failure. */
import { validateWindowsIdentity, windowsPath } from './live-vision-windows-carrier-core.mjs'
import { win32 } from 'node:path'
const quote=s=>`'${s.replaceAll("'","''")}'`
export function windowsVisionChildrenCommand(identity,path){
 validateWindowsIdentity(identity,{path,sessionId:identity.sessionId})
 return `$ErrorActionPreference='Stop';$stage='pin-native';$failureCode='NATIVE_PIN_UNCONFIRMED';$p=$null;$stages=[Collections.Generic.List[object]]::new();$rows=[Collections.Generic.List[object]]::new();$nativePinned=$false;$nativeStillPinned=$false;$passed=$false;$failure=$null;$systemDirectory=$null
function Hash-ChildBytes([byte[]]$b){$h=[Security.Cryptography.SHA256]::Create();try{([BitConverter]::ToString($h.ComputeHash($b))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}}
function Hash-ChildText([string]$s){Hash-ChildBytes ([Text.Encoding]::UTF8.GetBytes($s))}
function Get-TrustedConsole([string]$image){
 $system=[IO.Path]::GetFullPath([Environment]::SystemDirectory);$windows=[Environment]::GetFolderPath([Environment+SpecialFolder]::Windows);$expected=[IO.Path]::GetFullPath((Join-Path $windows 'System32'))
 if($system-ine $expected){throw 'System directory provenance unavailable'}
 $console=[IO.Path]::GetFullPath((Join-Path $system 'conhost.exe'))
 if($image-ine $console){throw 'Not the canonical system console'}
 foreach($item in @((Get-Item -LiteralPath $windows),(Get-Item -LiteralPath $system),(Get-Item -LiteralPath $console))){if($item.Attributes-band [IO.FileAttributes]::ReparsePoint){throw 'System console reparse point'}}
 $locked=$null;try{
  $locked=[IO.File]::Open($console,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  $before=Get-Item -LiteralPath $console;$hash=(Get-FileHash -LiteralPath $console -Algorithm SHA256).Hash.ToLowerInvariant();$sig=Get-AuthenticodeSignature -LiteralPath $console -ErrorAction Stop
  if($sig.Status.ToString()-cne 'Valid'-or !$sig.SignerCertificate){throw 'System console signature unavailable'}
  $publisher=$sig.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false)
  if(@('Microsoft Windows','Microsoft Windows Publisher','Microsoft Corporation') -notcontains $publisher -or $sig.SignerCertificate.Subject -notmatch '(?:^|,\\s*)O=Microsoft Corporation(?:,|$)'){throw 'System console publisher mismatch'}
  $after=Get-Item -LiteralPath $console;$afterHash=(Get-FileHash -LiteralPath $console -Algorithm SHA256).Hash.ToLowerInvariant()
  if($before.Length-le 0-or $before.Length-ne $after.Length-or $before.LastWriteTimeUtc.Ticks-ne $after.LastWriteTimeUtc.Ticks-or $hash-cne $afterHash){throw 'System console file changed'}
  return @{systemDirectory=$system;systemDirectorySource='Environment.SystemDirectory';systemRootMatched=$true;systemPathMatched=$true;reparsePoint=$false;stable=$true;fileSha256=$hash;bytes=$after.Length;lastWriteTicks=$after.LastWriteTimeUtc.Ticks.ToString();signatureStatus='Valid';microsoftPublisher=$true;signerSha256=(Hash-ChildBytes $sig.SignerCertificate.RawData)}
 }finally{if($locked){$locked.Dispose()}}
}
try{
 $p=[Diagnostics.Process]::GetProcessById(${identity.pid});$null=$p.SafeHandle
 if($p.StartTime.ToUniversalTime().Ticks.ToString()-cne '${identity.createdAtTicks}'-or $p.MainModule.FileName-ine ${quote(path)}-or $p.SessionId-ne ${identity.sessionId}){$failureCode='NATIVE_IDENTITY_CHANGED';throw 'Own native pin changed'}
 $nc=Get-CimInstance Win32_Process -Filter 'ProcessId=${identity.pid}'
 if(!$nc-or $nc.CreationDate.ToUniversalTime().Ticks-ne ([long]'${identity.createdAtTicks}'-([long]'${identity.createdAtTicks}'%10))-or $nc.ExecutablePath-ine ${quote(path)}-or [int]$nc.ParentProcessId-ne ${identity.parentPid}-or [int]$nc.SessionId-ne ${identity.sessionId}){$failureCode='NATIVE_CIM_CHANGED';throw 'Own native CIM changed'}
 $nativePinned=$true;$stages.Add(@{stage=$stage;passed=$true})
 $stage='enumerate-cim';$failureCode='CHILD_ENUMERATION_UNCONFIRMED';$children=@(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${identity.pid}')
 if($children.Count-gt 256){$failureCode='CHILD_COUNT_BOUND';throw 'Own child count bound'};$stages.Add(@{stage=$stage;passed=$true;count=$children.Count})
 foreach($c in $children){$v=$null;try{
  $stage='pin-child';$failureCode='CHILD_PIN_UNCONFIRMED';$v=[Diagnostics.Process]::GetProcessById([int]$c.ProcessId);$null=$v.SafeHandle;$birth=$v.StartTime.ToUniversalTime().Ticks;$image=$v.MainModule.FileName
  if([int]$c.ParentProcessId-ne ${identity.pid}-or !$c.CreationDate-or $c.CreationDate.ToUniversalTime().Ticks-ne ($birth-($birth%10))-or $birth-lt [long]'${identity.createdAtTicks}'-or [int]$c.SessionId-ne ${identity.sessionId}-or $v.SessionId-ne ${identity.sessionId}-or [string]::IsNullOrEmpty($c.ExecutablePath)-or $c.ExecutablePath-ine $image){$failureCode='CHILD_IDENTITY_CHANGED';throw 'Own child corroboration failed'}
  $row=@{pid=$v.Id;parentPid=${identity.pid};createdAtTicks=$birth.ToString();sessionId=$v.SessionId;cimBirthMatched=$true;parentMatched=$true;sessionMatched=$true;imagePathSHA256=(Hash-ChildText $image.ToLowerInvariant());pathClass='unclassified'}
  $rows.Add($row);$stages.Add(@{stage=$stage;passed=$true;pid=$v.Id})
  $stage='classify-path';$failureCode='CHILD_EXECUTABLE_CHANGED'
  if($image-ieq ${quote(path)}){$row.pathClass='native-executable';$row.executablePath=$image}
  elseif($image-ieq (Join-Path ([Environment]::SystemDirectory) 'conhost.exe')){$failureCode='SYSTEM_CONSOLE_TRUST_UNCONFIRMED';$row.consoleTrust=Get-TrustedConsole $image;$systemDirectory=$row.consoleTrust.systemDirectory;$row.pathClass='trusted-system-console';$row.executablePath=$image}
  else{$row.pathClass='other-executable';throw 'Own child is not the native executable'}
  $stages.Add(@{stage=$stage;passed=$true;pid=$v.Id;pathClass=$row.pathClass})
 }finally{if($v){$v.Dispose()}}}
 $stage='recheck-native';$failureCode='NATIVE_RECHECK_UNCONFIRMED';$p.Refresh();if($p.HasExited-or $p.StartTime.ToUniversalTime().Ticks.ToString()-cne '${identity.createdAtTicks}'-or $p.MainModule.FileName-ine ${quote(path)}-or $p.SessionId-ne ${identity.sessionId}){throw 'Own native changed during child snapshot'};$nativeStillPinned=$true;$stages.Add(@{stage=$stage;passed=$true});$passed=$true
}catch{
 $kind=if($_.Exception-is [ArgumentException]){'argument'}elseif($_.Exception-is [ComponentModel.Win32Exception]){'win32'}elseif($_.Exception-is [InvalidOperationException]){'invalid-operation'}else{'other'}
 $failure=@{stage=$stage;code=$failureCode;exceptionKind=$kind;hresult=$_.Exception.HResult;messageSHA256=(Hash-ChildText $_.Exception.Message)};$stages.Add(@{stage=$stage;passed=$false})
}finally{if($p){$p.Dispose()}}
@{version=1;scope='one-live-native-direct-child-snapshot';coversShutdownChildren=$false;coversRecursiveTree=$false;nativePinned=$nativePinned;nativeStillPinned=$nativeStillPinned;systemDirectory=$systemDirectory;passed=$passed;stages=@($stages.ToArray());candidates=@($rows.ToArray());failure=$failure}|ConvertTo-Json -Depth 8 -Compress`
}
export function windowsVisionChildrenPassed(value,identity,path){
 try{
  validateWindowsIdentity(identity,{path,sessionId:identity.sessionId})
  if(value?.version!==1||value.scope!=='one-live-native-direct-child-snapshot'||value.coversShutdownChildren!==false||value.coversRecursiveTree!==false||value.nativePinned!==true||value.nativeStillPinned!==true||value.passed!==true||value.failure!==null||!Array.isArray(value.stages)||value.stages.some(x=>x.passed!==true)||!Array.isArray(value.candidates)||value.candidates.length>256)return false
  if(value.stages[0]?.stage!=='pin-native'||value.stages[1]?.stage!=='enumerate-cim'||value.stages.at(-1)?.stage!=='recheck-native'||value.stages.length!==3+2*value.candidates.length||value.stages.filter(x=>x.stage==='pin-native').length!==1||value.stages.filter(x=>x.stage==='enumerate-cim').length!==1||value.stages.find(x=>x.stage==='enumerate-cim').count!==value.candidates.length||new Set(value.candidates.map(x=>x.pid)).size!==value.candidates.length)return false
  if(value.stages.filter(x=>x.stage==='recheck-native').length!==1)return false
  return value.candidates.every(row=>{validateWindowsIdentity(row,{parentPid:identity.pid,sessionId:identity.sessionId});const native=row.pathClass==='native-executable'&&windowsPath(row.executablePath)===windowsPath(path),trust=row.consoleTrust,console=row.pathClass==='trusted-system-console'&&trust?.systemDirectorySource==='Environment.SystemDirectory'&&trust.systemRootMatched===true&&trust.systemPathMatched===true&&trust.reparsePoint===false&&trust.stable===true&&trust.signatureStatus==='Valid'&&trust.microsoftPublisher===true&&/^[a-f0-9]{64}$/u.test(trust.fileSha256??'')&&/^[a-f0-9]{64}$/u.test(trust.signerSha256??'')&&Number.isSafeInteger(trust.bytes)&&trust.bytes>0&&/^\d{17,20}$/u.test(trust.lastWriteTicks??'')&&windowsPath(trust.systemDirectory)===windowsPath(value.systemDirectory)&&win32.basename(trust.systemDirectory).toLowerCase()==='system32'&&windowsPath(row.executablePath)===windowsPath(win32.join(trust.systemDirectory,'conhost.exe'));return row.cimBirthMatched===true&&row.parentMatched===true&&row.sessionMatched===true&&(native||console)&&BigInt(row.createdAtTicks)>=BigInt(identity.createdAtTicks)&&value.stages.some(s=>s.stage==='pin-child'&&s.pid===row.pid)&&value.stages.some(s=>s.stage==='classify-path'&&s.pid===row.pid&&s.pathClass===row.pathClass)})
 }catch{return false}
}
