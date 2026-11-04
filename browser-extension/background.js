import { createTaskGroups } from './groups.js'
const endpoint = 'http://127.0.0.1:47931'
let client = crypto.randomUUID(), running = false, connected = false
const browser = /Edg\//.test(navigator.userAgent) ? 'edge' : 'chrome'
const tasks = createTaskGroups(chrome)
chrome.tabs.onCreated.addListener(tasks.onCreated)
chrome.tabs.onRemoved.addListener(tasks.removed)
const headers = { 'X-Qiuya-Extension': chrome.runtime.id, 'Content-Type': 'application/json' }
const address = path => endpoint + path + '?client=' + client + '&browser=' + browser

async function connect() {
  if (running) return
  running = true
  try {
    for (;;) {
      const response = await fetch(address('/poll'), { headers, signal: AbortSignal.timeout(25_000), cache: 'no-store' })
      if (!response.ok) break
      connected = true
      const command = await response.json()
      if (command.kind === 'end') { tasks.end(command.operations); continue }
      if (!command.id) continue
      const result = await tasks.applyGroup(command)
      await fetch(address('/reply'), { method: 'POST', headers, body: JSON.stringify(result), signal: AbortSignal.timeout(4000) })
    }
  } catch { /* A stopped/restarted Harness is retried by the alarm. */ }
  finally { running = false; connected = false; tasks.disconnect() }
}
chrome.alarms.create('qiuya-connect', { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'qiuya-connect') void connect() })
chrome.runtime.onStartup.addListener(connect)
chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.type === 'qiuya-group-reconnect') void connect()
  if (message?.type === 'qiuya-group-status' || message?.type === 'qiuya-group-reconnect') reply({ connected, optional: true })
})
void connect()
