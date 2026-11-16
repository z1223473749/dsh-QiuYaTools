// Match the horizon of the theme plate's bottom-right cover crop.
const PLATE_WIDTH = 1440
const PLATE_HEIGHT = 901
const HORIZON = .849
const ripples = Array.from({ length: 65 }, (_, index) => ({
  x: (index * 67 % 101) / 101,
  depth: .08 + (index * 29 % 97) / 109,
  spread: .65 + (index * 17 % 31) / 35,
  offset: index * 2.39996,
}))

export function createBluefishWater(phase: HTMLElement, win: Window & typeof globalThis) {
  const doc = phase.ownerDocument
  const layer = doc.createElement('div')
  layer.className = 'qyt-bluefish-water'
  layer.setAttribute('aria-hidden', 'true')
  const canvas = doc.createElement('canvas')
  const context = canvas.getContext('2d')
  layer.append(canvas)
  phase.prepend(layer)
  let last = -Infinity
  let left = 0

  function measure() {
    const rect = phase.getBoundingClientRect()
    const scale = Math.max(win.innerWidth / PLATE_WIDTH, win.innerHeight / PLATE_HEIGHT)
    const horizon = win.innerHeight - PLATE_HEIGHT * scale * (1 - HORIZON)
    const width = Math.round(rect.width)
    const height = Math.round(rect.bottom - Math.max(rect.top, horizon))
    canvas.hidden = width <= 0 || height <= 0
    if (canvas.hidden) return
    left = rect.left
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height
    canvas.style.height = `${height}px`
  }
  const resize = new win.ResizeObserver(measure)
  resize.observe(phase)
  win.addEventListener('resize', measure)
  measure()

  return {
    element: layer,
    draw(now: number) {
      if (now - last < 42 || canvas.hidden || !context) return
      last = now
      const t = now / 1000
      const { width, height } = canvas
      context.clearRect(0, 0, width, height)
      for (const { x, depth, spread, offset } of ripples) {
        const drift = Math.sin(t * 1.25 + offset)
        const y = (depth + drift * .027) * height
        const center = x * width + drift * (3 + depth * 12)
        const length = (5 + depth ** 2 * Math.min(76, width * .16)) * spread
        const glow = Math.max(0, 1 - (left + center) / Math.max(1, win.innerWidth * .7))
        const curl = Math.sin(t * 1.48 + offset + 1.3) * depth * 3
        const fade = (.05 + .13 * depth) * (.5 + .5 * Math.cos(t * 1.8 + offset) ** 2)
        context.fillStyle = `rgba(${Math.round(204 + glow * 51)}, ${Math.round(233 + glow * 11)}, ${Math.round(255 - glow * 40)}, ${fade})`
        context.beginPath()
        context.moveTo(center - length, y + curl)
        context.quadraticCurveTo(center - length * .12, y - 2 - depth * 3, center + length, y + curl * .75)
        context.quadraticCurveTo(center - length * .12, y + .3 + depth * 2, center - length, y + curl)
        context.fill()
      }
      if (!canvas.dataset.ready) canvas.dataset.ready = 'true'
    },
    dispose() {
      resize.disconnect()
      win.removeEventListener('resize', measure)
      layer.remove()
      canvas.width = canvas.height = 1
    },
  }
}
