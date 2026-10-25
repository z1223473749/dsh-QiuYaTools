import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
<key>CFBundleIconFile</key><string>QiuYaTools.icns</string>
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

export async function buildMacOSComputer({ outputDirectory = new URL('../lib/', import.meta.url), universal = process.env.QIUYA_TOOLS_UNIVERSAL === '1', signingIdentity = process.env.QIUYA_MACOS_SIGNING_IDENTITY ?? '-' } = {}) {
  if (process.platform !== 'darwin') return { skipped: true, reason: 'platform' }
  const contents = new URL(`./${COMPUTER_APP_NAME}/Contents/`, outputDirectory)
  const macOS = new URL('./MacOS/', contents)
  await mkdir(macOS, { recursive: true })
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  await writeFile(new URL('./Info.plist', contents), computerAppInfoPlist(pkg.version))
  const executable = fileURLToPath(new URL('./qiuya-computer', macOS))
  const architectures = universal ? ['arm64', 'x86_64'] : [process.arch === 'arm64' ? 'arm64' : 'x86_64']
  const files = ['Protocol.swift', 'Capture.swift', 'LeaseGuard.swift', 'Applications.swift', 'MacTransport.swift', 'PermissionGuide.swift', 'OperationBadge.swift', 'CursorOverlay.swift', 'FocusPreparation.swift', 'Input.swift', 'Preview.swift', 'main.swift'].map(name => fileURLToPath(new URL(`../src/native/macos/${name}`, import.meta.url)))
  const run = (command, args, quiet = false) => new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', quiet ? 'ignore' : 'inherit', 'inherit'] })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} failed (${code})`)))
  })
  // Ship the toolbox's existing artwork as a real Finder/drag-source app icon.
  // Build only image-format variants; the source artwork is unchanged.
  const iconWork = await mkdtemp(join(tmpdir(), 'qiuya-computer-icon-'))
  try {
    const iconset = join(iconWork, 'QiuYaTools.iconset')
    await mkdir(iconset)
    const source = fileURLToPath(new URL('../assets/icon-color.webp', import.meta.url))
    for (const size of [16, 32, 128, 256, 512]) {
      await run('/usr/bin/sips', ['-s', 'format', 'png', '-z', String(size), String(size), source, '--out', join(iconset, `icon_${size}x${size}.png`)], true)
      if (size < 512) await run('/usr/bin/sips', ['-s', 'format', 'png', '-z', String(size * 2), String(size * 2), source, '--out', join(iconset, `icon_${size}x${size}@2x.png`)], true)
    }
    const resources = new URL('./Resources/', contents); await mkdir(resources, { recursive: true })
    await run('/usr/bin/iconutil', ['--convert', 'icns', iconset, '--output', fileURLToPath(new URL('./QiuYaTools.icns', resources))])
  } finally { await rm(iconWork, { recursive: true, force: true }) }
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
  // Signing just the thin Mach-O leaves Info.plist unbound and advertises the
  // compiler's temporary architecture filename as its identity. Seal the whole
  // app after lipo/resources so the app offered to System Settings is genuine.
  const application = fileURLToPath(new URL(`./${COMPUTER_APP_NAME}/`, outputDirectory))
  await run('/usr/bin/codesign', ['--force', '--sign', signingIdentity, '--identifier', COMPUTER_BUNDLE_ID,
    ...(signingIdentity === '-' ? ['--timestamp=none'] : ['--timestamp']), application])
  await run('/usr/bin/codesign', ['--verify', '--strict', application])
  return { executable, architectures }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(JSON.stringify(await buildMacOSComputer({ universal: process.argv.includes('--universal') || process.env.QIUYA_TOOLS_UNIVERSAL === '1' })))
}
