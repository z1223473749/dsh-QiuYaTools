param([string]$Ready,[string]$Token)
$ErrorActionPreference='Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'windows-virtual-input-fixture.cs') -ReferencedAssemblies System.Windows.Forms,System.Drawing,System.Web.Extensions
[QytVirtualFixture]::Run($Ready,$Token)
