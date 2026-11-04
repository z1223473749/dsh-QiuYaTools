const status = document.getElementById('status'), detail = document.getElementById('detail'), dot = document.getElementById('dot'), button = document.getElementById('reconnect')
async function refresh() {
  try {
    const state = await chrome.runtime.sendMessage({ type: 'qiuya-group-status' })
    dot.dataset.connected = String(state?.connected === true)
    status.textContent = state?.connected ? '已连接 Harness' : '尚未连接 Harness'
    detail.textContent = state?.connected ? '浏览器任务可显示以操作目的命名的标签组；新打开的相关标签可加入同组。' : '电脑操控与浏览器操作仍可正常使用，仅不显示任务标签组。打开 Harness 并启用 QiuYaTools 后会自动连接。'
  } catch { dot.dataset.connected = 'false'; status.textContent = '尚未连接 Harness' }
}
button.addEventListener('click', async () => { button.disabled = true; try { await chrome.runtime.sendMessage({ type: 'qiuya-group-reconnect' }); await refresh() } finally { button.disabled = false } })
void refresh()
