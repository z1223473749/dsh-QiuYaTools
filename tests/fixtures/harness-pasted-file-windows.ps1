param([Parameter(Mandatory=$true)][string]$ProfileRoot,[Parameter(Mandatory=$true)][ValidateSet('before','after')][string]$Operation,[Parameter(Mandatory=$true)][string]$ExpectedSHA256,[Parameter(Mandatory=$true)][int]$ExpectedBytes,[string]$FileName)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
if($ProfileRoot -notmatch '\\qiuya-harness-e2e-[A-Za-z0-9]{6}\\qiuya-harness-home$' -or $ProfileRoot -cne [IO.Path]::GetFullPath($ProfileRoot) -or $ExpectedSHA256 -cnotmatch '^[a-f0-9]{64}$' -or $ExpectedBytes -lt 1 -or $ExpectedBytes -gt 4096){throw 'Invalid own nonce-file binding'}
function DirectItem([string]$Path,[bool]$Directory){$v=Get-Item -LiteralPath $Path -Force;if(($v.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne 0 -or $v.PSIsContainer -ne $Directory){throw 'Own attachment path must have no reparse components'};return $v}
$root=DirectItem $ProfileRoot $true
# Reject a reparse point in every existing component, including ancestors.
$ancestor=$root
while($ancestor){if(($ancestor.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne 0){throw 'Own profile ancestor is a reparse point'};$ancestor=$ancestor.Parent}
$parts=@('attachments','v1','files',$ExpectedSHA256.Substring(0,2),$ExpectedSHA256);$bucket=$ProfileRoot;$missing=$false
foreach($part in $parts){$bucket=Join-Path $bucket $part;if(-not(Test-Path -LiteralPath $bucket)){if($Operation-eq'before'){$missing=$true;break};throw 'Own attachment directory is absent'};[void](DirectItem $bucket $true)}
if($Operation-eq'before'){if(-not$missing){throw 'Nonce attachment bucket already exists before paste'};@{operation='before';profileBound=$true;nonceBucketAbsent=$true;readOnly=$true}|ConvertTo-Json -Compress;exit 0}
if($FileName -cnotmatch '^\u7c98\u8d34\u6587\u672c-\d{8}-\d{6}-[a-f0-9]{8}\.txt$'){throw 'Invalid observed official TXT filename'}
$items=@(Get-ChildItem -LiteralPath $bucket -Force);if($items.Count-ne 1 -or $items[0].Name-cne$FileName){throw 'Own nonce bucket must contain exactly the observed TXT'}
$leaf=Join-Path $bucket $FileName
Add-Type -TypeDefinition @'
using System;using System.Text;using System.Runtime.InteropServices;using Microsoft.Win32.SafeHandles;
public static class QytPastedFileHandle {
 [StructLayout(LayoutKind.Sequential)] public struct Info {public uint Attributes;public System.Runtime.InteropServices.ComTypes.FILETIME Creation,Access,Write;public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;}
 [DllImport("kernel32.dll",SetLastError=true)]public static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info info);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]public static extern uint GetFinalPathNameByHandle(SafeFileHandle h,StringBuilder path,uint length,uint flags);
 [DllImport("kernel32.dll",EntryPoint="CreateFileW",CharSet=CharSet.Unicode,SetLastError=true)]private static extern SafeFileHandle OpenFile(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
 public static System.IO.FileStream OpenRead(string path) {
  // Keep the observed canonical path; extended syntax only avoids MAX_PATH.
  // OPEN_REPARSE_POINT plus the handle attributes below refuse linked leaves.
  var handle=OpenFile(@"\\?\"+path,0x80000000,1,IntPtr.Zero,3,0x08200000,IntPtr.Zero);
  if(handle.IsInvalid){var error=Marshal.GetLastWin32Error();handle.Dispose();throw new System.ComponentModel.Win32Exception(error);}
  try{return new System.IO.FileStream(handle,System.IO.FileAccess.Read);}catch{handle.Dispose();throw;}
 }
}
'@
$stream=[QytPastedFileHandle]::OpenRead($leaf)
try{
 $first=[QytPastedFileHandle+Info]::new();if(-not[QytPastedFileHandle]::GetFileInformationByHandle($stream.SafeFileHandle,[ref]$first)-or$first.Links-lt 1-or($first.Attributes-band 0x410)-ne 0-or$first.SizeHigh-ne 0-or$first.SizeLow-ne$ExpectedBytes){throw 'Own opened TXT identity is invalid'}
 $canonical=[Text.StringBuilder]::new(32768);$n=[QytPastedFileHandle]::GetFinalPathNameByHandle($stream.SafeFileHandle,$canonical,32768,0);if($n-eq 0-or$n-ge 32768-or$canonical.ToString()-ine('\\?\'+$leaf)){throw 'Own opened TXT escaped its bound path'}
 $hash=[Security.Cryptography.SHA256]::Create();try{$actual=([BitConverter]::ToString($hash.ComputeHash($stream))).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()}
 $bytes=$stream.Position;$last=[QytPastedFileHandle+Info]::new();if(-not[QytPastedFileHandle]::GetFileInformationByHandle($stream.SafeFileHandle,[ref]$last)-or$last.Volume-ne$first.Volume-or$last.IndexHigh-ne$first.IndexHigh-or$last.IndexLow-ne$first.IndexLow-or$last.Links-ne$first.Links-or$last.SizeHigh-ne$first.SizeHigh-or$last.SizeLow-ne$first.SizeLow-or$last.Write.dwHighDateTime-ne$first.Write.dwHighDateTime-or$last.Write.dwLowDateTime-ne$first.Write.dwLowDateTime){throw 'Own TXT changed during read'}
 $lastPath=[Text.StringBuilder]::new(32768);$lastLength=[QytPastedFileHandle]::GetFinalPathNameByHandle($stream.SafeFileHandle,$lastPath,32768,0);if($lastLength-eq 0-or$lastLength-ge 32768-or$lastPath.ToString()-ine('\\?\'+$leaf)){throw 'Own TXT final path changed during read'}
 if($bytes-ne$ExpectedBytes-or$actual-cne$ExpectedSHA256){throw 'Actual stored TXT hash differs'}
 $currentRoot=DirectItem $ProfileRoot $true;if($currentRoot.CreationTimeUtc.Ticks-ne$root.CreationTimeUtc.Ticks){throw 'Own profile changed during read'}
 $path=$ProfileRoot;foreach($part in $parts){$path=Join-Path $path $part;[void](DirectItem $path $true)}
 $againStream=[QytPastedFileHandle]::OpenRead($leaf);try{$againInfo=[QytPastedFileHandle+Info]::new();if(-not[QytPastedFileHandle]::GetFileInformationByHandle($againStream.SafeFileHandle,[ref]$againInfo)-or($againInfo.Attributes-band 0x410)-ne 0-or$againInfo.Volume-ne$first.Volume-or$againInfo.IndexHigh-ne$first.IndexHigh-or$againInfo.IndexLow-ne$first.IndexLow){throw 'Own TXT path was replaced'}}finally{$againStream.Dispose()}
 $again=@(Get-ChildItem -LiteralPath $bucket -Force);if($again.Count-ne 1-or$again[0].Name-cne$FileName){throw 'Own nonce bucket changed during read'}
 @{operation='after';name=$FileName;bytes=$bytes;sha256=$actual;storedBytesVerified=$true;profileBound=$true;uniqueFile=$true;reparseRejected=$true;linkCount=[int]$last.Links;handleIdentityVerified=$true;readOnly=$true;source='independent-own-file-handle'}|ConvertTo-Json -Compress
}finally{$stream.Dispose()}
