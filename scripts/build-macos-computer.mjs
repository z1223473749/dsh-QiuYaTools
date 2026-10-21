import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

export const COMPUTER_APP_NAME = 'QiuYaTools Computer.app'
export const COMPUTER_BUNDLE_ID = 'com.qiuya.tools.computer-use'
export function computerAppInfoPlist(version) {
  if (!/^[0-9]+(?:\.[0-9]+)*(?:[-+][A-Za-z0-9.-]+)?$/u.test(version)) throw new Error('Invalid helper version')
  const bundleVersion = version.split(/[-+]/u)[0]
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${COMPUTER_BUNDLE_ID}</string>
<key>CFBundleName</key><string>QiuYaTools Computer</string>
<key>CFBundleDisplayName</key><string>QiuYaTools Computer</string>
<key>CFBundleExecutable</key><string>qiuya-computer</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>${bundleVersion}</string>
<key>CFBundleShortVersionString</key><string>${bundleVersion}</string>
<key>QiuYaToolsPackageVersion</key><string>${version}</string>
<key>LSUIElement</key><true/>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSScreenCaptureUsageDescription</key><string>Show the selected application window to your computer-use session and live preview.</string>
<key>NSAccessibilityUsageDescription</key><string>Read and control only the application selected for your computer-use session.</string>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
`
}

export async function buildMacOSComputer({ outputDirectory = new URL('../lib/', import.meta.url), universal = process.env.QIUYA_TOOLS_UNIVERSAL === '1' } = {}) {
  if (process.platform !== 'darwin') return { skipped: true, reason: 'platform' }
  const contents = new URL(`./${COMPUTER_APP_NAME}/Contents/`, outputDirectory)
  const macOS = new URL('./MacOS/', contents)
  await mkdir(macOS, { recursive: true })
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  await writeFile(new URL('./Info.plist', contents), computerAppInfoPlist(pkg.version))
  const executable = fileURLToPath(new URL('./qiuya-computer', macOS))
  const architectures = universal ? ['arm64', 'x86_64'] : [process.arch === 'arm64' ? 'arm64' : 'x86_64']
  const files = ['Protocol.swift', 'Capture.swift', 'LeaseGuard.swift', 'Applications.swift', 'OperationBadge.swift', 'CursorOverlay.swift', 'FocusPreparation.swift', 'Input.swift', 'Preview.swift', 'main.swift'].map(name => fileURLToPath(new URL(`../src/native/macos/${name}`, import.meta.url)))
  const run = (command, args) => new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'] })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} failed (${code})`)))
  })
  try {
    for (const architecture of architectures) {
      await run('/usr/bin/swiftc', ['-O', '-swift-version', '5', '-target', `${architecture}-apple-macosx13.0`,
        '-framework', 'AppKit', '-framework', 'WebKit', '-framework', 'ScreenCaptureKit', '-framework', 'ApplicationServices',
        '-framework', 'CoreImage', '-framework', 'CoreMedia', '-module-cache-path', '/tmp/qiuya-computer-swift-cache',
        ...files, '-o', universal ? `${executable}.${architecture}` : executable])
    }
    if (universal) await run('/usr/bin/lipo', ['-create', ...architectures.map(architecture => `${executable}.${architecture}`), '-output', executable])
  } finally {
    for (const architecture of architectures) await rm(`${executable}.${architecture}`, { force: true })
  }
  return { executable, architectures }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(JSON.stringify(await buildMacOSComputer({ universal: process.argv.includes('--universal') || process.env.QIUYA_TOOLS_UNIVERSAL === '1' })))
}
