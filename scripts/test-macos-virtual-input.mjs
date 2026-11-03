/** Own disposable background window only. No global keyboard/mouse injection or permission prompt. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
const execute = promisify(execFile)
if (process.platform !== 'darwin') throw Error('macOS acceptance requires macOS')
const directory = await mkdtemp('/tmp/qiuya-virtual-acceptance-'), source = fileURLToPath(new URL('../src/native/macos/', import.meta.url))
const common = ['-swift-version', '5', '-parse-as-library', '-framework', 'AppKit', '-framework', 'ApplicationServices', '-module-cache-path', '/tmp/qiuya-computer-swift-cache']
await execute('/usr/bin/swiftc', [...common, join(source, 'fixtures/VirtualInputAcceptanceFixture.swift'), '-o', join(directory, 'fixture')])
await execute('/usr/bin/swiftc', [...common, join(source, 'Protocol.swift'), join(source, 'VirtualInput.swift'), join(source, 'fixtures/VirtualInputAcceptance.swift'), '-o', join(directory, 'acceptance')])
const report = join(directory, 'report.json')
const result = await execute(join(directory, 'acceptance'), [join(directory, 'fixture'), join(directory, 'state.json'), report], { timeout: 20_000 })
process.stdout.write(result.stdout)
process.stdout.write(`Report: ${report}\n`)
