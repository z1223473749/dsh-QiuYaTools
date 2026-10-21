/** Test-only read-only readiness for the exact owned Mac preview snapshot. */
export function hasVisibleMacPreviewFrame(view) {
  const labels = view.labels ?? []
  return ['暂停', '接管', '继续', '停止', '实时电脑画面'].every(label => labels.includes(label))
    && Number.isFinite(view.canvas?.width) && view.canvas.width > 0
    && Number.isFinite(view.canvas?.height) && view.canvas.height > 0
    && (view.recognizedText ?? []).some(text => /\d+\s*ms/u.test(text))
}

export async function waitForOwnedMacPreview(read, { timeoutMs = 15000, intervalMs = 150, onAttempt = () => {} } = {}) {
  const deadline = Date.now() + timeoutMs
  do {
    const view = await read()
    onAttempt(view)
    if (hasVisibleMacPreviewFrame(view)) return view
    if (Date.now() >= deadline) break
    await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, Math.max(0, deadline - Date.now()))))
  } while (Date.now() < deadline)
  throw new Error('The owned Mac preview did not expose its controls, image and visible successful frame latency within the bounded wait')
}
