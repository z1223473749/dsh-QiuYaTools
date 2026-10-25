/** Test-only Harness UI renderer; production browser fields remain in original setup. */
import assert from 'node:assert/strict'
export const INSTALLED_EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const quote = value => "'" + value.replaceAll("'", "''") + "'"
export function rendererBinding(options) {
  const value = options.arch.installedRenderer
  assert(value && value.channel === 'msedge' && value.kind === 'explicit-installed-isolated-renderer', 'Explicit installed Edge binding required')
  assert.equal(value.path, INSTALLED_EDGE)
  assert.match(value.sha256, /^[a-f0-9]{64}$/u)
  assert.match(value.observedReportSHA256, /^[a-f0-9]{64}$/u)
  return value
}
/** Inject only into reviewed source anchors; a changed setup must be reviewed again. */
export function withInstalledRenderer({ makeRuntimeSetup: originalMake, assessSetup: originalAssess }) {
  assert.equal(typeof originalMake, 'function'); assert.equal(typeof originalAssess, 'function')
  return {
    makeRuntimeSetup(options) {
      const binding = rendererBinding(options), source = originalMake(options)
      const start = '$self=Get-Process -Id $PID;', end = 'if($clock.ElapsedMilliseconds-gt 60000)'
      assert.equal(source.split(start).length, 2); assert.equal(source.split(end).length, 2)
      const prepare = '$qytRenderer=' + quote(binding.path) + ';$qytRendererItem=Get-Item -LiteralPath $qytRenderer;if($qytRendererItem.PSIsContainer-or ($qytRendererItem.Attributes-band [IO.FileAttributes]::ReparsePoint)-or $qytRendererItem.FullName-cne ' + quote(binding.path) + "){throw 'Explicit renderer canonical path mismatch'};$qytRendererSHA=(Get-FileHash -LiteralPath $qytRenderer -Algorithm SHA256).Hash.ToLowerInvariant();if($qytRendererSHA-cne " + quote(binding.sha256) + "){throw 'Explicit renderer SHA mismatch'};"
      const assign = "$value.renderer=@{path=$qytRendererItem.FullName;sha256=$qytRendererSHA;bytes=$qytRendererItem.Length;version=$qytRendererItem.VersionInfo.FileVersion;channel='msedge'};"
      return source.replace(start, prepare + start).replace(end, assign + end)
    },
    assessSetup(value, options) {
      const binding = rendererBinding(options)
      originalAssess(value, options)
      assert.equal(value.renderer.path, binding.path); assert.equal(value.renderer.sha256, binding.sha256)
      assert.equal(value.renderer.channel, 'msedge'); assert(value.renderer.bytes > 0 && value.renderer.version)
      return value
    },
  }
}
