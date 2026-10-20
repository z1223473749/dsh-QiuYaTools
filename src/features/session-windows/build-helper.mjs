import { mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

export const SESSION_WINDOW_APP_NAME = 'QiuYaTools Sessions.app'
export const SESSION_WINDOW_BUNDLE_ID = 'com.qiuya.tools.session-window'

/** Stable native identity for normal Dock/window management and accessibility. */
export function sessionWindowAppInfoPlist(version) {
  if (!/^[0-9]+(?:\.[0-9]+)*(?:[-+][A-Za-z0-9.-]+)?$/u.test(version)) throw new Error('Invalid helper bundle version')
  const bundleVersion = version.split(/[-+]/u)[0]
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>${SESSION_WINDOW_BUNDLE_ID}</string>
  <key>CFBundleName</key><string>QiuYaTools Sessions</string>
  <key>CFBundleDisplayName</key><string>QiuYaTools Session Windows</string>
  <key>CFBundleExecutable</key><string>qiuya-session-window</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>${bundleVersion}</string>
  <key>CFBundleShortVersionString</key><string>${bundleVersion}</string>
  <key>QiuYaToolsPackageVersion</key><string>${version}</string>
  <key>LSUIElement</key><false/>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict>
    <key>NSAllowsLocalNetworking</key><true/>
    <key>NSAllowsArbitraryLoadsInWebContent</key><true/>
  </dict>
</dict></plist>
`
}

/** Release builds contain both Mac architectures; local builds can use the current one. */
export async function buildSessionWindowHelper(outputDirectory = new URL('../../../lib/', import.meta.url)) {
  await mkdir(outputDirectory, { recursive: true })
  const source = new URL('./SessionWindow.swift', import.meta.url)
  await copyFile(source, new URL('./SessionWindow.swift', outputDirectory))
  // Clean only the obsolete helper artifact emitted by earlier plugin builds.
  await rm(new URL('./qiuya-session-window', outputDirectory), { force: true })
  if (process.platform !== 'darwin') return
  const contents = new URL(`./${SESSION_WINDOW_APP_NAME}/Contents/`, outputDirectory)
  const macOS = new URL('./MacOS/', contents)
  const chinese = new URL('./Resources/zh-Hans.lproj/', contents)
  await mkdir(macOS, { recursive: true })
  await mkdir(chinese, { recursive: true })
  const pkg = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8'))
  await writeFile(new URL('./Info.plist', contents), sessionWindowAppInfoPlist(pkg.version))
  await writeFile(new URL('./InfoPlist.strings', chinese), '"CFBundleName" = "QiuYaTools 会话窗口";\n"CFBundleDisplayName" = "QiuYaTools 会话窗口";\n')
  const output = fileURLToPath(new URL('./qiuya-session-window', macOS))
  const architecture = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x86_64' : undefined
  if (!architecture) throw new Error(`Unsupported native session-window architecture: ${process.arch}`)
  const run = (command, args) => new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'] })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Native helper build failed (${code})`)))
  })
  const universal = process.env.QIUYA_TOOLS_UNIVERSAL === '1'
  const architectures = universal ? ['arm64', 'x86_64'] : [architecture]
  try {
    for (const target of architectures) {
      await run('/usr/bin/swiftc', ['-O', '-target', `${target}-apple-macosx13.0`, '-framework', 'AppKit', '-framework', 'WebKit', '-module-cache-path', '/tmp/qiuya-tools-swift-module-cache', fileURLToPath(source), '-o', universal ? `${output}.${target}` : output])
    }
    if (universal) await run('/usr/bin/lipo', ['-create', ...architectures.map(target => `${output}.${target}`), '-output', output])
  } finally {
    if (universal) for (const target of architectures) await rm(`${output}.${target}`, { force: true })
  }
}
