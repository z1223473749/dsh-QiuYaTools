/** Test-only owned PS observer. It holds the original console/Host/helper handles
 * across the normal EOF boundary and never sends a process signal. */
import { spawn } from 'node:child_process'
export function startHarnessWindowsWindowRetirement({ command = 'powershell.exe', args, spawnChild = spawn, readyMs = 30000, retireMs = 3000 }) {
  const child = spawnChild(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let carry = '', stderr = '', bytes = 0, first, final, began = false, terminal, readyTimer, retireTimer, closed
  let readyResolve, readyReject, finishResolve, finishReject
  const ready = new Promise((yes, no) => { readyResolve = yes; readyReject = no }), finished = new Promise((yes, no) => { finishResolve = yes; finishReject = no })
  void ready.catch(() => {}); void finished.catch(() => {})
  const fail = error => {
    if (terminal) return
    terminal = error; clearTimeout(readyTimer); clearTimeout(retireTimer); readyReject(error); finishReject(error)
    if (!child.stdin.writableEnded) child.stdin.end()
  }
  child.stdin.on('error', () => fail(new Error('Own normal-close observer pipe failed')))
  child.stderr.on('data', chunk => { if (stderr.length < 8192) stderr += chunk.toString('utf8').slice(0, 8192 - stderr.length) })
  child.stdout.on('data', chunk => {
    if (terminal) return
    bytes += chunk.length; carry += chunk.toString('utf8')
    if (bytes > 128 * 1024) return fail(new Error('Own normal-close observer output limit'))
    let at
    while ((at = carry.indexOf('\n')) >= 0) {
      const line = carry.slice(0, at); carry = carry.slice(at + 1); if (!line.trim()) continue
      let row; try { row = JSON.parse(line) } catch { fail(new Error('Own normal-close observer invalid JSON')); continue }
      if (!first && row?.phase === 'window-group-released') { first = row; clearTimeout(readyTimer); readyResolve(row) }
      else if (first && began && !final && row?.phase === 'host-console-released') final = row
      else fail(new Error('Own normal-close observer phase or replay changed'))
    }
  })
  child.once('error', () => fail(new Error('Own normal-close observer failed to start')))
  child.once('close', (code, signal) => {
    closed = { code, signal }; clearTimeout(readyTimer); clearTimeout(retireTimer)
    if (terminal) return
    if (carry.trim() || !first || !began || !final || code !== 0 || signal !== null) return fail(new Error('Own normal-close observer did not naturally finish: ' + (stderr || 'missing original phase/exit receipt')))
    finishResolve({ ...final, observerExit: closed, processSignalsSent: 0 })
  })
  readyTimer = setTimeout(() => fail(new Error('Own normal-close observer did not confirm the business window group within30000ms')), readyMs)
  return {
    ready: () => ready,
    beginHostEOF() {
      if (terminal || !first || began || closed) throw terminal ?? new Error('Own normal-close observer EOF may be issued exactly once after its window-group receipt')
      began = true
      retireTimer = setTimeout(() => fail(new Error('Own original Host/helper/console observer did not naturally retire within3000ms after Host EOF')), retireMs)
      child.stdin.end('host-eof\n')
    },
    finish: () => finished,
    abortBeforeHostEOF() { if (!child.stdin.writableEnded) child.stdin.end() },
  }
}
