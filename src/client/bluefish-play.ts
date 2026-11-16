const SVG = 'http://www.w3.org/2000/svg'

export function createBluefishPlay(phase: HTMLElement, mascot: HTMLElement) {
  const doc = phase.ownerDocument
  const sleep = doc.createElement('i')
  sleep.className = 'qyt-bluefish-sleep'
  sleep.textContent = 'z z Z'
  const fish = doc.createElementNS(SVG, 'svg')
  fish.classList.add('qyt-bluefish-little-fish')
  fish.setAttribute('viewBox', '0 0 66 34')
  fish.setAttribute('aria-hidden', 'true')
  fish.innerHTML = '<path d="M46 16 64 7l-5 10 5 10-18-7Z" fill="#7ba9df" stroke="#527cbd" stroke-width="1.6"/><path d="M4 17C16 1 34 2 49 17 34 33 15 32 4 17Z" fill="#bbd9f3" stroke="#527cbd" stroke-width="1.6"/><path d="m26 9 6-6 6 8m-8 8 6 4-8 2" fill="#85acdd"/><circle cx="16" cy="15" r="2" fill="#334876"/><path d="M12 20q3 3 6 0" fill="none" stroke="#6684ba" stroke-linecap="round"/>'
  const butterfly = doc.createElementNS(SVG, 'svg')
  butterfly.classList.add('qyt-bluefish-butterfly')
  butterfly.setAttribute('viewBox', '0 0 56 48')
  butterfly.setAttribute('aria-hidden', 'true')
  butterfly.innerHTML = '<g data-wings=""><g fill="#f8cfe9" stroke="#aa6ea5" stroke-width="1.1"><path d="M28 26C7 20 1 4 12 3q13 0 16 23C22 46 7 44 11 34q3-8 17-8Z"/><path d="M28 26C49 20 55 4 44 3q-13 0-16 23c6 20 21 18 17 8q-3-8-17-8Z"/></g><g fill="#fff6ef" opacity=".88"><path d="M13 9q11 5 13 14Q12 20 13 9Zm30 0Q32 14 30 23 44 20 43 9Z"/><circle cx="17" cy="34" r="3"/><circle cx="39" cy="34" r="3"/></g></g><path d="M28 18v16m0-14q-2-8-7-9m7 9q2-8 7-9" fill="none" stroke="#775a83" stroke-linecap="round" stroke-width="1.6"/>'
  const caught = fish.cloneNode(true) as SVGSVGElement
  caught.setAttribute('class', 'qyt-bluefish-caught-fish')
  mascot.append(sleep, caught)
  phase.append(fish, butterfly)
  let fishSwim: Animation | undefined
  const bubbles = new Map<HTMLElement, Animation>()
  let serial = 0
  const wings = butterfly.querySelector('[data-wings]')!

  function flutter(x: number, y: number, opacity: number, angle = 0, time = 0) {
    if (!opacity) { butterfly.style.opacity = '0'; return }
    butterfly.style.transform = `translate(${x}px,${y}px) translate(-50%,-50%) rotate(${angle}deg)`
    butterfly.style.opacity = String(opacity)
    wings.setAttribute('transform', `translate(28 0) scale(${.38 + Math.abs(Math.sin(time * .023)) * .62} 1) translate(-28 0)`)
  }

  function emit(tool: 'gun' | 'wand', x: number, y: number, direction: number) {
    const scene = phase.getBoundingClientRect()
    const pet = mascot.getBoundingClientRect()
    const count = tool === 'gun' ? 4 : 2
    for (let i = 0; i < count && bubbles.size < 30; i++) {
      const seed = ++serial
      const size = 9 + (seed * 7 % 20) + (tool === 'wand' ? 7 : 0)
      const bubble = doc.createElement('i')
      bubble.className = 'qyt-bluefish-emitted-bubble'
      bubble.dataset.source = tool
      bubble.dataset.choreography = mascot.dataset.choreography
      bubble.setAttribute('aria-hidden', 'true')
      bubble.style.cssText = `left:${pet.left - scene.left + pet.width * x - size / 2}px;top:${pet.top - scene.top + pet.height * y - size / 2}px;width:${size}px;height:${size}px`
      phase.append(bubble)
      const dx = direction * (15 + seed * 13 % 50)
      const dy = 86 + seed * 19 % 140
      const rise = bubble.animate([
        { transform: 'scale(.26)', opacity: 0 },
        { transform: `translate(${dx * .52}px, -18px) scale(.9)`, opacity: .93, offset: .15 },
        { transform: `translate(${dx}px, ${-dy * .71}px)`, opacity: .78, offset: .74 },
        { transform: `translate(${dx * 1.3}px, ${-dy}px) scale(1.1)`, opacity: 0 },
      ], { duration: 2100 + seed * 137 % 1700, delay: i * (tool === 'gun' ? 32 : 130), fill: 'both' })
      bubbles.set(bubble, rise)
      rise.finished.catch(() => {}).finally(() => {
        if (bubbles.get(bubble) === rise) { bubbles.delete(bubble); bubble.remove() }
      })
    }
  }

  function popAt(x: number, y: number) {
    for (const [bubble, rise] of bubbles) {
      if (Number(doc.defaultView!.getComputedStyle(bubble).opacity) < .2) continue
      const rect = bubble.getBoundingClientRect()
      if (Math.hypot(x - rect.left - rect.width / 2, y - rect.top - rect.height / 2) > rect.width / 2 + 3) continue
      const transform = doc.defaultView!.getComputedStyle(bubble).transform
      rise.cancel()
      const pop = bubble.animate([{ transform, scale: 1, opacity: .8 }, { transform, scale: 1.8, opacity: 0 }], { duration: 240 })
      bubbles.set(bubble, pop)
      pop.finished.catch(() => {}).finally(() => { bubbles.delete(bubble); bubble.remove() })
      return true
    }
    return false
  }

  function stopFish() {
    fishSwim?.cancel()
    fishSwim = undefined
  }

  function startFish(distance: number) {
    stopFish()
    fishSwim = fish.animate([
      { transform: 'translateX(0)', opacity: 0, offset: 0 },
      { transform: 'translate(-20px, -8px)', opacity: .9, offset: .15 },
      { transform: `translate(${-.55 * distance}px, -13px)`, opacity: .9, offset: .37 },
      { transform: `translate(${-distance}px, 0)`, opacity: .96, offset: .51 },
      { transform: `translate(${-distance}px, -18px) scale(.8)`, opacity: 0, offset: .57 },
      { opacity: 0, offset: 1 },
    ], { duration: 4800 })
  }

  return {
    startFish, stopFish, emit, popAt, flutter,
    dispose() {
      stopFish(); fish.remove(); butterfly.remove()
      for (const [bubble, animation] of bubbles) { animation.cancel(); bubble.remove() }
      bubbles.clear()
    },
  }
}
