# Disposable Harness E2E observer: invoke only a named button in the exact
# PID/start-time-bound native preview window selected by the companion.
param([Parameter(Mandatory=$true)][string]$WindowId, [string]$Button = '')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$pieces = $WindowId.Split(':')
if ($pieces.Length -ne 4 -or $pieces[0] -ne 'window') { throw 'Invalid fixture window identity' }
$handle = [IntPtr]([Convert]::ToInt64($pieces[1], 16))
$targetProcess = Get-Process -Id ([int]$pieces[2])
if ($targetProcess.StartTime.ToUniversalTime().Ticks -ne [long]$pieces[3]) { throw 'Fixture process identity changed' }
$element = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
if ($element.Current.ProcessId -ne $targetProcess.Id -or -not $element.Current.Name.StartsWith('QiuYaTools')) { throw 'Fixture must be the exact native computer preview' }
$items = $element.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$labels = New-Object 'System.Collections.Generic.List[string]'
$pressed = $false
for ($i = 0; $i -lt [Math]::Min($items.Count, 300); $i++) {
  $item = $items.Item($i)
  $label = $item.Current.Name
  if ($label) { $labels.Add($label) }
  if ($Button -and -not $pressed -and $label -eq $Button -and $item.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button) {
    $pattern = $item.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $pattern.Invoke()
    $pressed = $true
  }
}
if ($Button -and -not $pressed) { throw 'Native preview button was not invokable' }
@{ targetId=$WindowId; pid=$targetProcess.Id; labels=$labels.ToArray(); pressed=$pressed } | ConvertTo-Json -Compress
