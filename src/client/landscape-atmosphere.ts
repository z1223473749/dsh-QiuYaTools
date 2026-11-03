import { ATMOSPHERE_COLORS, type ThemeAtmosphere } from '../custom-themes.ts'

/** Bounded DOM artwork: gradients supply depth without per-frame blur filters. */
export function createAtmosphere(doc: Document, kind: ThemeAtmosphere, color?: string): HTMLElement[] {
  const tint = color && /^#[\da-f]{6}$/i.test(color) ? color : ATMOSPHERE_COLORS[kind]
  const count = kind === 'none' ? 0 : kind === 'aurora' ? 3 : kind === 'bubbles' ? 16 : kind === 'glow' ? 20 : kind === 'fireflies' ? 26 : 38
  return Array.from({ length: count }, (_, i) => {
    const dot = doc.createElement('i'), depth = .45 + (i * .381966 % .55)
    const size = kind === 'aurora' ? 0 : kind === 'bubbles' ? 12 + i % 5 * 6 : kind === 'petals' ? 7 + i % 4 * 2 : kind === 'glow' ? 5 + i % 4 * 3 : 2 + i % 4
    dot.dataset.qytAtmosphere = kind
    dot.style.cssText = `position:absolute;top:0;left:0;opacity:0;width:${size}px;height:${size}px;border-radius:50%;will-change:transform,opacity;`
    if (kind === 'petals') {
      dot.style.cssText += `border-radius:85% 15% 75% 25%;background:radial-gradient(ellipse at 28% 24%,#fff9,transparent 60%),linear-gradient(135deg,${tint}dd,${tint}66);box-shadow:inset 1px 1px 1px #ffffff66,0 2px 4px ${tint}22;`
    } else if (kind === 'bubbles') {
      dot.style.cssText += `background:radial-gradient(circle at 28% 25%,#ffffffcc,transparent 16%),radial-gradient(circle at 55% 60%,transparent 48%,${tint}55 78%,${tint}bb);border:1px solid ${tint}88;box-shadow:inset 0 0 5px ${tint}44,0 0 8px ${tint}22;`
    } else if (kind === 'stars') {
      dot.style.cssText += `width:${8 + i % 3 * 4}px;height:${8 + i % 3 * 4}px;background:radial-gradient(circle,#fff 0%,${tint} 16%,${tint}00 65%);`
      const rays = doc.createElement('span')
      rays.style.cssText = `position:absolute;inset:0;background:linear-gradient(transparent,${tint},transparent) center/15% 100% no-repeat,linear-gradient(90deg,transparent,${tint},transparent) center/100% 15% no-repeat;`
      dot.append(rays)
    } else if (kind === 'aurora') {
      dot.style.cssText += `width:110%;height:65%;border-radius:50%;background:radial-gradient(ellipse at 50% 50%,${tint}00 25%,${tint}33 43%,${tint}77 50%,${tint}22 58%,${tint}00 72%);transform-origin:50% 50%;`
    } else {
      dot.style.cssText += `background:radial-gradient(circle,#fff 0%,${tint} 22%,${tint}88 40%,${tint}00 72%);box-shadow:${kind === 'snow' ? `0 0 3px ${tint}77` : `0 0 ${kind === 'glow' ? 14 : 7}px ${tint}66`};`
    }
    dot.dataset.depth = String(depth)
    return dot
  })
}

export function drawAtmosphere(particles: HTMLElement[], kind: ThemeAtmosphere, time: number, strength: number, width: number, height: number, reading: boolean): void {
  const margin = Math.max(20, (width - 720) / 2 - 20)
  for (const [i, dot] of particles.entries()) {
    const seed = i * 2.399963, depth = Number(dot.dataset.depth)
    if (kind === 'aurora') {
      dot.style.transform = `translate(${-width * .1 + Math.sin(time * .12 + seed) * width * .12}px,${-height * .14 + i * height * .14}px) rotate(${-20 + Math.sin(time * .15 + seed) * 14}deg) scale(1,${.6 + Math.sin(time * .18 + seed) * .2})`
      dot.style.opacity = String(strength * (reading ? .16 : .48) * (.7 + Math.sin(time * .3 + seed) * .25))
      continue
    }
    const rising = ['glow', 'fireflies', 'bubbles'].includes(kind)
    const progress = ((i * .618034 + time * (rising ? -.025 : .048) * depth) % 1 + 1) % 1
    const baseX = reading ? (i % 2 ? width - 10 - i * 17 % margin : 10 + i * 17 % margin) : (.04 + (i * .754878 % .92)) * width
    const flutter = Math.sin(time * (kind === 'fireflies' ? .9 : .5) + seed)
    const px = baseX + flutter * (reading ? 5 : kind === 'fireflies' ? 28 : 16) * strength
    const py = kind === 'stars' ? (.04 + i * .381966 % .92) * height + Math.sin(time * .3 + seed) * 5 : progress * (height + 60) - 30
    const fade = kind === 'stars' ? Math.pow((Math.sin(time * .9 + seed) + 1) / 2, 2) : Math.min(1, progress * 10, (1 - progress) * 10)
    const flicker = kind === 'fireflies' ? .4 + (Math.sin(time * 1.8 + seed) + 1) * .3 : .85
    const rotation = kind === 'petals' ? seed + time * .45 : kind === 'stars' ? Math.sin(time * .25 + seed) * .2 : 0
    dot.style.transform = `translate(${px}px,${py}px) rotate(${rotation}rad) scale(${depth}${kind === 'petals' ? `,${.4 + Math.abs(flutter) * .6}` : ''})`
    dot.style.opacity = String(strength * fade * flicker * (kind === 'glow' ? .65 : .9))
  }
}
