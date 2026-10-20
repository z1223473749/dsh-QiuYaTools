import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') { console.log('Skipped native macOS self-test on this platform'); process.exit(0) }
const directory = await mkdtemp(join(tmpdir(), 'qiuya-computer-selftest-'))
const root = fileURLToPath(new URL('../src/native/macos/', import.meta.url))
const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: 'inherit' }); child.once('error', reject)
  child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)))
})
try {
  const executable = join(directory, 'native-selftest')
  await run('/usr/bin/swiftc', ['-swift-version', '5', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx13.0`, '-framework', 'AppKit', '-framework', 'WebKit', '-framework', 'ApplicationServices',
    '-module-cache-path', '/tmp/qiuya-computer-swift-cache', ...['Protocol.swift', 'Input.swift', 'Preview.swift', 'fixtures/NativeSelfTest.swift'].map(name => join(root, name)), '-o', executable])
  await run(executable, [])
} finally { await rm(directory, { recursive: true, force: true }) }
