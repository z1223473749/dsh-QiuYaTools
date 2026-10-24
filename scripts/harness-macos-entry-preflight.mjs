/** Pure entry selection guard. Never reads a file, starts a process or requests input. */
export const MAC_NATIVE_PREPARATION_REQUIRED = 'MAC_NATIVE_ACCEPTANCE_PREPARATION_REQUIRED'
export const MAC_NATIVE_PREPARATION_GUIDANCE = 'Mac 原生兼容验收需要先绑定当前候选包、组件和源码。请先运行 node scripts/prepare-macos-full-harness-acceptance.mjs /absolute/full12-options.json，再使用生成的 entry.mjs --run --gui-gate root-approved --root-approved。未启动 Host、浏览器或系统输入。'

export function assertHarnessMacEntryPrepared({ platform = process.platform, argv = process.argv, prepared = false, headlessSubset = false } = {}) {
  // These booleans are source bindings in the manifest-checked snapshot. Public
  // command-line flags or environment variables cannot manufacture preparation.
  if (platform !== 'darwin' || prepared === true || headlessSubset === true || argv.includes('--pasted-text-only')) return
  throw Object.assign(new Error(MAC_NATIVE_PREPARATION_GUIDANCE), { code: MAC_NATIVE_PREPARATION_REQUIRED })
}
