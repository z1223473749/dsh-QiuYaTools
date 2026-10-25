import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { ComputerError } from './contract.ts'

const INPUT_RELEASE_MS = 1500
const WINDOWS_DRAIN_MS = 8000
const EXIT_CONFIRM_MS = 2000
const MAX_RECEIPT_LINE = 1024

/** EOF must release input first. Only that exact worker's timely ACK permits a longer WebView drain. */
export function waitForComputerRetirement(child: ChildProcessWithoutNullStreams, platform: NodeJS.Platform = process.platform, onExit?: (receipt: { inputReleased: boolean }) => void): Promise<{ inputReleased: boolean; browserShutdownPassed: boolean | null; forced: boolean; code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const started = performance.now()
    let inputReleased = false, forced = false, eofIssued = false, finished = false
    let browserShutdownPassed: boolean | null = null
    let line = '', discarding = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let confirmation: ReturnType<typeof setTimeout> | undefined
    const cleanup = (): void => {
      clearTimeout(timer); clearTimeout(confirmation)
      child.stdout.off('data', read); child.off('exit', exited); child.off('close', closed)
    }
    const unknown = (): void => {
      if (finished) return
      finished = true; cleanup()
      reject(new ComputerError('NATIVE_CLEANUP_FAILED', '执行器未确认退出，已阻止新的电脑输入。'))
    }
    const confirm = (): void => {
      if (confirmation) return
      confirmation = setTimeout(unknown, EXIT_CONFIRM_MS); confirmation.unref()
    }
    const stop = (): void => {
      if (finished) return
      if (child.exitCode === null && child.signalCode === null) { forced = true; child.kill('SIGKILL') }
      confirm()
    }
    const receipt = (value: string): void => {
      if (platform !== 'win32' || !eofIssued) return
      let message: unknown
      try { message = JSON.parse(value) } catch { return }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return
      const record = message as Record<string, unknown>
      if (Object.keys(record).sort().join('|') !== 'event|passed') return
      if (record.event === 'browserShutdown' && inputReleased && typeof record.passed === 'boolean') {
        if (record.passed === false) browserShutdownPassed = false
        else if (browserShutdownPassed !== false) browserShutdownPassed = true
        return
      }
      if (inputReleased || performance.now() - started >= INPUT_RELEASE_MS || child.exitCode !== null || child.signalCode !== null) return
      if (record.event !== 'inputReleased' || record.passed !== true) return
      inputReleased = true
      clearTimeout(timer)
      // The budget is absolute from EOF; duplicate receipts never refresh it.
      timer = setTimeout(stop, Math.max(0, WINDOWS_DRAIN_MS - (performance.now() - started))); timer.unref()
    }
    const read = (chunk: string | Buffer): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      let offset = 0
      while (offset < text.length) {
        const end = text.indexOf('\n', offset), part = text.slice(offset, end < 0 ? undefined : end)
        if (!discarding) {
          if (line.length + part.length <= MAX_RECEIPT_LINE) line += part
          else { line = ''; discarding = true }
        }
        if (end < 0) break
        if (!discarding) receipt(line.trim())
        line = ''; discarding = false; offset = end + 1
      }
    }
    const exited = (): void => {
      clearTimeout(timer); confirm()
      // A dead worker cannot send more input. Its owned emergency release must
      // not wait for a descendant that still happens to hold the stdout pipe.
      onExit?.({ inputReleased })
    }
    const closed = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (finished) return
      finished = true; cleanup(); resolve({ inputReleased, browserShutdownPassed, forced, code, signal })
    }
    if (platform === 'win32') child.stdout.on('data', read)
    child.once('exit', exited); child.once('close', closed)
    timer = setTimeout(stop, INPUT_RELEASE_MS); timer.unref()
    eofIssued = true
    child.stdin.end()
  })
}
