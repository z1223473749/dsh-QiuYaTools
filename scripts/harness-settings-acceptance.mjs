/** Test-only public settings-page oracle. No configuration writes or model calls. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, relative, resolve, sep, win32 } from 'node:path'

export const SETTINGS_ACCEPTANCE_PAGES = [
  { id: 'computer', label: '电脑操控', heading: '电脑操控', toggle: '启用电脑操控', regions: ['系统权限', '始终允许的应用', '电脑任务概览'] },
  { id: 'pastedTextEnabled', label: '长文本', heading: '大文本粘贴转 TXT 附件', toggle: '大文本粘贴转 TXT 附件', kind: 'thresholds' },
  { id: 'sessionWindowsEnabled', label: '独立窗口', heading: '会话独立窗口', toggle: '会话独立窗口', steps: ['新窗口打开', '拖出列表'], kind: 'windows' },
  { id: 'bulkArchiveEnabled', label: '批量归档', heading: '会话多选与批量归档', toggle: '会话多选与批量归档', steps: ['Shift', '右键已选会话', '右键工作区'] },
  { id: 'planCommentsEnabled', label: '计划批注', heading: '计划批注与修改建议', toggle: '计划批注与修改建议', steps: ['选中文字添加批注', '计划卡片', '原有内容会保留'] },
  { id: 'sidebarToolsEnabled', label: '会话菜单', heading: '会话与工作区菜单', toggle: '会话与工作区菜单', steps: ['置顶', '标记为未读', '会话 ID', '打开目录'] },
  { id: 'promptSuggestionsEnabled', label: '提示词', heading: '输入框提示词推荐', toggle: '输入框提示词推荐', steps: ['失焦后仍保留', 'Tab', '模型用量'] },
  { id: 'qTheme', label: 'Q 主题', heading: '启用 Q 主题', toggle: '启用 Q 主题', kind: 'theme' },
  { id: 'about', label: '关于我们', heading: 'QiuYaTools.', kind: 'about' },
  { id: 'updates', label: '版本更新', heading: '版本更新', kind: 'updates' },
]

/** Serializable browser function; returns only this page's allowlisted UI state. */
export function inspectSettingsTab(section, expected) {
  const require = (condition, message) => { if (!condition) throw new Error(`Settings ${expected.label}: ${message}`) }
  const text = node => node?.textContent?.replace(/\s+/gu, ' ').trim() ?? ''
  const selected = [...section.querySelectorAll('[role="tab"][aria-selected="true"]')]
  require(selected.length === 1 && text(selected[0]) === expected.label, 'the requested tab is not uniquely selected')
  const panel = [...section.querySelectorAll('[role="tabpanel"]')].find(node => node.id === selected[0].getAttribute('aria-controls'))
  require(panel && !panel.hidden && panel.getAttribute('aria-labelledby') === selected[0].id, 'the selected tab does not own its visible panel')
  require([...section.querySelectorAll('[role="tabpanel"]')].filter(node => !node.hidden).length === 1, 'multiple panels are exposed')
  require([...panel.querySelectorAll('h3')].some(node => text(node) === expected.heading), 'page-specific heading/content is missing')
  const master = section.querySelector('.qyt-master-toggle')
  require(master && !master.disabled && section.querySelector('.qyt-status')?.getAttribute('data-state') !== 'pending', 'the isolated writable settings have not loaded')
  const evidence = { id: expected.id, label: expected.label, heading: expected.heading }
  if (expected.toggle) {
    const toggle = [...panel.querySelectorAll('[role="switch"]')].find(node => node.getAttribute('aria-label') === expected.toggle)
    require(toggle && ['true', 'false'].includes(toggle.getAttribute('aria-checked')), 'the page-specific switch has no boolean state')
    require(!toggle.disabled, 'the page-specific switch is unavailable in the supported writable Host')
    evidence.checked = toggle.getAttribute('aria-checked') === 'true'
  }
  for (const label of expected.regions ?? []) require(panel.querySelector(`section[aria-label="${label}"]`), `region ${label} is missing`)
  if (expected.id === 'computer') {
    require([...panel.querySelectorAll('summary')].some(node => text(node).startsWith('高级操作环境')), 'the advanced environment disclosure is missing')
    require([...panel.querySelectorAll('button')].some(node => text(node) === '重新检查'), 'permission recheck is missing')
    require([...panel.querySelectorAll('button')].some(node => text(node) === '添加应用'), 'application authorization entry is missing')
    evidence.advancedExpanded = panel.querySelector('details')?.open === true
  }
  if (expected.steps) {
    const steps = [...panel.querySelectorAll('ol > li')].map(text)
    require(steps.length === expected.steps.length && expected.steps.every((fragment, index) => steps[index].includes(fragment)), 'page-specific usage steps are missing or belong to another page')
    evidence.guideSteps = steps.length
  }
  if (expected.kind === 'windows') require(text(panel).includes('最低支持官方 HARNESS 版本：'), 'the minimum Host version explanation is missing')
  if (expected.kind === 'thresholds') {
    const form = panel.querySelector('form[aria-label="TXT 转换阈值"]')
    require(form, 'the TXT threshold form is missing')
    evidence.thresholds = {}
    for (const [label, max] of [['字符数', 1000000], ['行数', 100000]]) {
      const input = [...form.querySelectorAll('label')].find(node => text(node.firstElementChild) === label)?.querySelector('input[type="number"]')
      require(input && !input.disabled && input.min === '1' && input.max === String(max) && Number.isSafeInteger(Number(input.value)) && Number(input.value) >= 1 && Number(input.value) <= max, `${label} has an invalid persisted value or range`)
      evidence.thresholds[label] = Number(input.value)
    }
    require([...form.querySelectorAll('button')].some(node => text(node) === '保存阈值'), 'the explicit threshold save action is missing')
  }
  if (expected.kind === 'theme') {
    require([...panel.querySelectorAll('h4')].some(node => text(node) === '鲸与海'), 'the theme preview title is missing')
    require(panel.querySelector('[role="img"][aria-label="鲸与海主题：手绘鲸鱼与白发少年、半透明纸面阅读区和海面侧栏。"]'), 'the accessible theme preview is missing')
  }
  if (expected.kind === 'about') {
    require(panel.querySelector('img[alt="白发少年坐在鲸鱼上"]'), 'the project artwork is missing')
    const links = panel.querySelector('nav[aria-label="项目与反馈"]')
    require(links && [...links.querySelectorAll('a')].some(node => text(node).includes('GitHub 开源')) && [...links.querySelectorAll('a')].some(node => text(node).includes('反馈与建议')), 'project and feedback links are missing')
    require(text(panel.querySelector('footer')).includes('MIT 开源'), 'the license attribution is missing')
  }
  if (expected.kind === 'updates') {
    const update = panel.querySelector('section[aria-label="插件更新"]')
    const version = text(section.querySelector('.qyt-version'))
    require(/^v\d+\.\d+\.\d+/u.test(version) && text(update?.querySelector('.qyt-about-current')) === `当前 ${version}`, 'the displayed update version differs from the installed plugin')
    require(update.getAttribute('aria-busy') === 'false' && update.querySelector('[role="status"][data-state="idle"]'), 'the initial update status is not idle')
    require([...update.querySelectorAll('button')].some(node => text(node) === '检查更新' && !node.disabled), 'the update check action is unavailable')
    require(panel.querySelector('[aria-label="更新步骤"]'), 'the update instructions are missing')
    evidence.currentVersion = version
  }
  return evidence
}

export async function captureSettingsTabs(page, { screenshot }) {
  const section = page.locator('.qyt-settings')
  await section.waitFor({ state: 'visible' })
  const results = []
  for (const [index, expected] of SETTINGS_ACCEPTANCE_PAGES.entries()) {
    const tab = page.getByRole('tab', { name: expected.label, exact: true })
    await tab.click()
    await page.waitForFunction(({ label, toggle }) => {
      const section = document.querySelector('.qyt-settings')
      const selected = section?.querySelector('[role="tab"][aria-selected="true"]')
      if (selected?.textContent?.trim() !== label || section.querySelector('.qyt-master-toggle')?.disabled !== false || section.querySelector('.qyt-status')?.getAttribute('data-state') === 'pending') return false
      const panel = [...section.querySelectorAll('[role="tabpanel"]')].find(node => node.id === selected.getAttribute('aria-controls'))
      if (!panel || panel.hidden) return false
      return !toggle || [...panel.querySelectorAll('[role="switch"]')].some(node => node.getAttribute('aria-label') === toggle && !node.disabled)
    }, expected)
    const panel = section.locator('[role="tabpanel"]:not([hidden])')
    await panel.waitFor({ state: 'visible' })
    const state = await section.evaluate(inspectSettingsTab, expected)
    // Fonts and this panel's real inline artwork must finish before a screenshot
    // can count as page evidence. This never clicks a preference or remote link.
    await section.evaluate(async node => {
      let timeout
      try { await Promise.race([Promise.all([document.fonts?.ready, ...[...node.querySelectorAll('[role="tabpanel"]:not([hidden]) img')].map(image => image.decode())]), new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('Settings artwork/font readiness timed out')), 10000) })]) }
      finally { clearTimeout(timeout) }
    })
    await panel.evaluate(node => { node.scrollTop = 0 })
    const images = []
    for (let segment = 0; segment < 8; segment++) {
      const bounds = await panel.evaluate(node => ({ top: node.scrollTop, height: node.clientHeight, total: node.scrollHeight }))
      assert.ok(bounds.height > 0, 'Settings panel has no visible viewport')
      images.push(await screenshot(`settings-${String(index + 1).padStart(2, '0')}-${expected.id}${segment ? `-scroll-${segment + 1}` : ''}`, section))
      if (bounds.top + bounds.height >= bounds.total - 2) break
      assert.ok(segment < 7, 'Settings panel exceeded the bounded screenshot traversal')
      await panel.evaluate(node => { node.scrollTop = Math.min(node.scrollHeight - node.clientHeight, node.scrollTop + Math.max(1, Math.floor(node.clientHeight * .8))) })
    }
    await panel.evaluate(node => { node.scrollTop = 0 })
    results.push({ ...state, screenshots: images })
  }
  // Preserve the original case's initial long-text page for later functional
  // assertions, without writing a single preference during the visual tour.
  await page.getByRole('tab', { name: '长文本', exact: true }).click()
  return { pages: results, boundary: 'Ten actual settings pages, page-specific semantic and writable-state checks, and cropped installed-UI screenshots. Browsing does not exercise every feature or prove real-model reasoning.' }
}

export function createHarnessImageLayout(output, requestedDirectory) {
  const directory = resolve(requestedDirectory ?? output), names = new Set()
  const path = name => { assert.match(name, /^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.(?:png|jpg)$/u); names.add(name); return join(directory, name) }
  const reference = name => relative(resolve(output), join(directory, name)).split(sep).join('/')
  return { directory, path, reference, async manifest() {
    const files = [], missing = []
    for (const name of [...names].sort()) {
      let bytes
      try { bytes = await readFile(join(directory, name)) } catch (error) { if (error.code === 'ENOENT') { missing.push(reference(name)); continue }; throw error }
      files.push({ name, path: reference(name), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    }
    return { directory: relative(resolve(output), directory).split(sep).join('/') || '.', files, missing }
  } }
}

/** Host paths never enter the Windows child argv. The guest uses its own root. */
export function windowsHarnessScreenshotPlan(output, requestedDirectory, guestRoot) {
  const external = requestedDirectory !== undefined
  if (external) assert.ok(typeof requestedDirectory === 'string' && requestedDirectory.length > 0, 'The host screenshot destination must be a nonempty directory')
  const folder = external ? 'screenshots' : 'evidence'
  const guestDirectory = win32.join(guestRoot, folder)
  return { external, folder, guestDirectory, hostDirectory: external ? resolve(requestedDirectory) : join(resolve(output), 'evidence'), argv: external ? ['--screenshots-dir', guestDirectory] : [] }
}

/** PowerShell 5.1 emits no JSON for an empty pipeline, and a scalar for one file. */
export function parseWindowsHarnessFileNames(source) {
  assert.equal(typeof source, 'string', 'The Windows file listing must be text')
  const text = source.trim()
  if (!text) return []
  // Malformed JSON must remain an error; an absent/empty listing is the only
  // non-JSON representation emitted by ConvertTo-Json for this file pipeline.
  const value = JSON.parse(text)
  const names = value === null ? [] : Array.isArray(value) ? value : [value]
  for (const name of names) {
    assert.equal(typeof name, 'string', 'The Windows file listing must contain file names')
    assert.match(name, /^[a-zA-Z0-9_.-]+$/u)
  }
  return names
}

export async function verifyCollectedHarnessImages(output, directory, manifest) {
  assert.ok(manifest && Array.isArray(manifest.files) && Array.isArray(manifest.missing), 'The guest screenshot manifest is missing')
  const files = [], seen = new Set()
  for (const image of manifest.files) {
    assert.match(image.name, /^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.(?:png|jpg)$/u)
    assert.ok(!seen.has(image.name), 'The guest screenshot manifest repeats an image')
    seen.add(image.name)
    const bytes = await readFile(join(directory, image.name))
    assert.equal(bytes.length, image.bytes, 'A screenshot changed size during collection')
    assert.equal(createHash('sha256').update(bytes).digest('hex'), image.sha256, 'A screenshot changed during Windows-to-host collection')
    files.push({ ...image, guestReference: image.path, path: relative(output, join(directory, image.name)).split(sep).join('/') })
  }
  return { status: 'passed', directory: relative(output, directory).split(sep).join('/') || '.', files, missing: manifest.missing,
    boundary: 'Raw guest report is preserved. These relative paths locate the byte-for-byte verified host copies; no host filesystem path was passed to Windows.' }
}
