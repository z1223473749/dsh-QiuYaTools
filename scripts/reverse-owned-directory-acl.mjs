/** Narrow test-carrier setup: one fresh UUID directory, one exact interactive SID. */
import assert from 'node:assert/strict'
import { win32 } from 'node:path'
const quote = value => "'" + value.replaceAll("'", "''") + "'"
export function assertReverseOwnedDirectoryAclProof({sid}, proof) {
  assert.match(sid, /^S-1-5-21-\d{1,10}-\d{1,10}-\d{1,10}-\d{1,10}$/u)
  assert.equal(proof?.passed,true);assert.equal(proof.scope,'exact-fresh-uuid-directory-only');assert.equal(proof.principalSid,sid)
  assert(['S-1-5-18','S-1-5-32-544'].includes(proof.ownerSid))
  assert([197055,1245631].includes(proof.rightsMask),'Only Modify with its optional Synchronize bit is allowed')
  assert.equal(proof.inheritanceFlags,3);assert.equal(proof.propagationFlags,0);assert.equal(proof.unrelatedAclUnchanged,true)
  assert.equal(proof.parentAclWritten,false);assert.equal(proof.globalAclWritten,false);assert.equal(proof.inputPosted,false)
  assert.deepEqual(proof.files,[{name:'remote.mjs',inheritedModify:true},{name:'client.mjs',inheritedModify:true},{name:'config.json',inheritedModify:true}])
  return proof
}
export function reverseOwnedDirectoryAclCommand({ directory, sid }) {
  assert.equal(typeof directory, 'string'); assert.match(directory, /^[a-z]:\\/iu)
  assert.equal(win32.normalize(directory), directory, 'Canonical owned directory required')
  assert(!directory.endsWith('\\'));assert(!/[<>:"|?*\x00-\x1f]/u.test(directory.slice(2)), 'Invalid Windows directory characters')
  assert.match(win32.basename(directory), /^QiuYaTools-reverse-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu)
  assert.match(sid, /^S-1-5-21-\d{1,10}-\d{1,10}-\d{1,10}-\d{1,10}$/u)
  const parent = win32.dirname(directory)
  return `$ErrorActionPreference='Stop'
$directory=${quote(directory)};$expectedParent=${quote(parent)};$principal=${quote(sid)}
$sid=[Security.Principal.SecurityIdentifier]::new($principal)
$root=[IO.Path]::GetFullPath($directory)
if($root -ine $directory -or [IO.Path]::GetDirectoryName($root) -ine $expectedParent){throw 'Owned directory canonical boundary changed'}
$item=Get-Item -LiteralPath $root -Force
if(!$item.PSIsContainer -or $item.FullName -ine $root){throw 'Owned directory identity changed'}
for($walk=$item;$null -ne $walk;$walk=$walk.Parent){if(($walk.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Owned directory ancestry contains a reparse point'}}
$acl=Get-Acl -LiteralPath $root
$owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
if($owner -notin @('S-1-5-18','S-1-5-32-544')){throw 'Owned directory owner is not SYSTEM or Administrators'}
if($acl.AreAccessRulesProtected){throw 'Fresh owned directory inheritance is protected'}
function Rules($value){@($value.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|ForEach-Object{$_.IdentityReference.Value+'|'+[long]$_.FileSystemRights+'|'+[int]$_.AccessControlType+'|'+[int]$_.InheritanceFlags+'|'+[int]$_.PropagationFlags+'|'+$_.IsInherited}|Sort-Object)}
$beforeRules=Rules $acl
$existing=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|Where-Object{$_.IdentityReference.Value -eq $principal})
if($existing.Count -ne 0){throw 'Fresh owned directory already contains a principal-specific ACE'}
$inherit=[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
$rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::Modify,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
$null=$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $root -AclObject $acl
$actual=Get-Acl -LiteralPath $root
if($actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $owner -or $actual.AreAccessRulesProtected){throw 'Owned directory owner or inheritance changed'}
$exact=@($actual.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|Where-Object{$_.IdentityReference.Value -eq $principal})
if($exact.Count -ne 1 -or $exact[0].IsInherited -or $exact[0].AccessControlType -ne 'Allow' -or $exact[0].FileSystemRights -ne $rule.FileSystemRights -or $exact[0].InheritanceFlags -ne $inherit -or $exact[0].PropagationFlags -ne 'None'){throw 'Exact principal Modify inheritance proof failed'}
$afterOthers=@(Rules $actual|Where-Object{!$_.StartsWith($principal+'|',[StringComparison]::Ordinal)})
if(($afterOthers -join "\n") -cne ($beforeRules -join "\n")){throw 'An unrelated ACE changed'}
$proofFiles=@()
foreach($name in @('remote.mjs','client.mjs','config.json')){
 $path=Join-Path $root $name;$file=Get-Item -LiteralPath $path -Force
 if($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or [IO.Path]::GetDirectoryName($file.FullName) -ine $root){throw 'Owned input file escaped its directory'}
 $fileAcl=Get-Acl -LiteralPath $path
 if($fileAcl.AreAccessRulesProtected -or $fileAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin @('S-1-5-18','S-1-5-32-544')){throw 'Owned input file owner or inheritance changed'}
 $fileRules=@($fileAcl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|Where-Object{$_.IdentityReference.Value -eq $principal})
 if($fileRules.Count -ne 1 -or !$fileRules[0].IsInherited -or $fileRules[0].AccessControlType -ne 'Allow' -or ($fileRules[0].FileSystemRights -band $rule.FileSystemRights) -ne $rule.FileSystemRights){throw 'Owned input file did not inherit exact principal Modify'}
 $proofFiles+=@{name=$name;inheritedModify=$true}
}
$again=Get-Item -LiteralPath $root -Force
if($again.FullName -ine $root -or ($again.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Owned directory changed after ACL proof'}
@{passed=$true;scope='exact-fresh-uuid-directory-only';principalSid=$principal;ownerSid=$owner;rightsMask=[long]$rule.FileSystemRights;inheritanceFlags=[int]$inherit;propagationFlags=0;unrelatedAclUnchanged=$true;files=$proofFiles;parentAclWritten=$false;globalAclWritten=$false;inputPosted=$false}|ConvertTo-Json -Depth 5 -Compress
`
}
