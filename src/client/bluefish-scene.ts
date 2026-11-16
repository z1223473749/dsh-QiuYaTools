import type { Context } from '@deepseek-ai/cordis'
import { createBluefishActions, type IdleAction } from './bluefish-actions.ts'
import { BLUEFISH_MEALS, createBluefishCharacter, type Affect, type Face } from './bluefish-character.ts'
import { createBluefishPlay } from './bluefish-play.ts'
import { createBluefishWater } from './bluefish-water.ts'
import { en, zh } from './locales.ts'

const PHASE = '[data-slot="main.conversation"] > [data-phase]'
const ACTIVITY = '[data-qyt-bluefish-session]'
const INTERACTIVE = 'button, input, textarea, select, a, label, summary, [role="button"], [role="link"], [contenteditable], [data-composer-seat], [data-composer-card], [data-slot="conversation.header"], [data-chat-node-key], [data-chat-group-part], [data-message-id], [data-turn], article, pre, [role="dialog"], .bubble, .composer'

export const BLUEFISH_FEED_EVENT = 'qyt-bluefish-feed'
export const BLUEFISH_PLAY_EVENT = 'qyt-bluefish-play'
export const BLUEFISH_BUBBLES_EVENT = 'qyt-bluefish-bubbles'

const REMIND_AFTER = [25, 40, 55, 70].map(minutes => minutes * 60_000)
type Mode = 'idle' | 'feed' | 'working' | 'finishing' | IdleAction
type Activity = { session: string; running: boolean; started: number; outcome?: string }
type Reminders = Map<string, { started: number; stage: number }>

function activityOf(phase: HTMLElement): Activity {
  const { body } = phase.ownerDocument
  if (body.hasAttribute('data-qyt-bluefish-preview')) {
    return { session: 'preview', running: body.hasAttribute('data-qyt-bluefish-demo'), started: Number(body.dataset.qytBluefishDemoStarted) || 0, outcome: 'completed' }
  }
  const { dataset } = phase.querySelector<HTMLElement>(ACTIVITY) ?? phase
  return {
    session: dataset.qytBluefishSession ?? '', running: dataset.qytBluefishRunning === 'true',
    started: Number(dataset.qytBluefishStarted) || 0, outcome: dataset.qytBluefishOutcome,
  }
}

function mountMascot(phase: HTMLElement, win: Window & typeof globalThis, reminders: Reminders, language: () => typeof zh | typeof en) {
  const doc = phase.ownerDocument
  const water = createBluefishWater(phase, win)
  const mascot = doc.createElement('div')
  mascot.className = 'qyt-bluefish-mascot'
  mascot.setAttribute('aria-hidden', 'true')
  const character = createBluefishCharacter(doc)
  mascot.append(character.element)
  phase.insertBefore(mascot, water.element.nextSibling)
  const pet = createBluefishPlay(phase, mascot)
  const actions = createBluefishActions(mascot, pet.flutter)
  const speech = doc.createElement('div')
  speech.className = 'qyt-bluefish-speech'
  speech.setAttribute('role', 'status')
  speech.hidden = true
  phase.append(speech)

  let mode: Mode = 'idle', pose: Face = 'idle', meal = 0, nextMeal = 0
  let poseSince = win.performance.now(), reactionSince = -Infinity
  let chew = 0
  let affect: Affect | undefined
  let timer = 0, affectTimer = 0, speechTimer = 0, raf = 0, lastFrame = 0, lastReminderCheck = 0
  let near = false, visible = true, idleTurn = 0, playTurn = 0, lastInput = Date.now()
  let pointer: { x: number; y: number } | undefined, gazeX = 0, gazeY = 0
  let taps: number[] = [], pendingFeed = false
  let shake: Animation | undefined
  let activity = activityOf(phase)
  let currentSession = activity.session

  function frame(next: Face) {
    if (pose !== next) {
      pose = next
      poseSince = win.performance.now()
    }
    if (next === 'idle' || next === 'look') delete mascot.dataset.meal
    else mascot.dataset.meal = BLUEFISH_MEALS[meal]
    mascot.dataset.pose = next
    mascot.dataset.mode = mode
  }

  function clearAffect() {
    affect = undefined
    delete mascot.dataset.affect
  }

  function after(ms: number, next: () => void) {
    win.clearTimeout(timer)
    timer = win.setTimeout(next, ms)
  }

  function emote(next: Affect, ms: number) {
    affect = next
    mascot.dataset.affect = next
    win.clearTimeout(affectTimer)
    affectTimer = win.setTimeout(clearAffect, ms)
  }

  function idle() {
    mode = 'idle'
    frame(near ? 'look' : 'idle')
    after(22_000 + (idleTurn % 3) * 3500, () => {
      if (Date.now() - lastInput > 38_000) { act('nap'); return }
      const next = ['fish', 'desk', 'bubbles', 'play'] as const
      act(next[idleTurn++ % next.length]!)
    })
  }

  function act(action: IdleAction) {
    win.clearTimeout(timer)
    mode = action
    frame('idle')
    const distance = Math.max(0, Math.min(phase.clientWidth * (action === 'play' ? .48 : .66), phase.clientWidth - mascot.offsetWidth - 20))
    actions.start(action, distance)
    if (action === 'play' || action === 'fish' || action === 'bubbles') {
      react()
      emote('happy', 1200)
    }
    if (action === 'fish') {
      pet.startFish(distance)
      after(2530, () => {
        emote('happy', 2100)
        reactionSince = win.performance.now()
      })
    }
  }

  function swallow() {
    if (mode === 'finishing' && activity.outcome !== 'completed') { idle(); return }
    frame('swallow')
    if (mode !== 'working') emote('happy', 850)
    after(mode === 'working' ? 310 : 540, () => {
      if (mode === 'working') lift()
      else idle()
    })
  }

  function lift() {
    meal = nextMeal++ % BLUEFISH_MEALS.length
    frame('lift')
    after(mode === 'working' ? 315 : 460, () => {
      frame('bite')
      after(mode === 'working' ? 225 : 290, () => {
        frame('chew')
        after(mode === 'working' ? 3 * 320 : 3 * 390, swallow)
      })
    })
  }

  function startWorking() {
    pendingFeed = false
    if (settleAction()) return
    win.clearTimeout(affectTimer)
    clearAffect()
    mode = 'working'
    lift()
  }

  function clearSpeech() {
    win.clearTimeout(speechTimer)
    speech.hidden = true
    speech.textContent = ''
    shake?.cancel()
  }

  function remind(now: number) {
    if (now - lastReminderCheck < 1000) return
    lastReminderCheck = now
    if (!activity.running || !activity.started || !activity.session) return
    const elapsed = Date.now() - activity.started
    const stage = REMIND_AFTER.filter(limit => elapsed >= limit).length
    const previous = reminders.get(activity.session)
    if (!stage || (previous?.started === activity.started && previous.stage >= stage)) return
    if (reminders.size >= 64) reminders.delete(reminders.keys().next().value!)
    reminders.set(activity.session, { started: activity.started, stage })
    const text = language()
    speech.textContent = [text.qThemeBluefishRestOne, text.qThemeBluefishRestTwo, text.qThemeBluefishRestThree, text.qThemeBluefishRestPlea][stage - 1]!
    speech.hidden = false
    win.clearTimeout(speechTimer)
    speechTimer = win.setTimeout(clearSpeech, stage === 4 ? 14_000 : 8500)
    if (stage === 4) {
      emote('worried', 4200)
      shake?.cancel()
      shake = phase.animate([
        { translate: '0px 0px' }, { translate: '-3px 0px', offset: .16 },
        { translate: '2.5px 0px', offset: .34 }, { translate: '-1.6px 0px', offset: .53 },
        { translate: '.8px 0px', offset: .74 }, { translate: '0px 0px' },
      ], { duration: 470, easing: 'ease-out' })
    }
  }

  function sync() {
    const old = activity
    activity = activityOf(phase)
    if (activity.session !== currentSession) {
      currentSession = activity.session
      pendingFeed = false
      pet.stopFish()
      actions.reset()
      clearSpeech()
      idle()
    }
    if (!visible) return
    if (activity.running && mode !== 'working') startWorking()
    if (activity.running || mode !== 'working') return
    if (old.running) clearSpeech()
    mode = 'finishing'
    mascot.dataset.mode = mode
    if (pose === 'lift') {
      if (activity.outcome === 'completed') swallow()
      else idle()
    }
  }

  function react() { reactionSince = win.performance.now() }

  function settleAction() {
    pet.stopFish()
    return actions.finish(win.performance.now())
  }

  function feed() {
    if (!visible) return
    if (mode === 'working' || mode === 'finishing' || mode === 'feed') { react(); return }
    if (settleAction()) { pendingFeed = true; return }
    pendingFeed = false
    mode = 'feed'
    react()
    frame('look')
    after(225, lift)
  }

  function play() {
    if (!visible) return
    react()
    if (mode === 'working' || mode === 'finishing' || mode === 'feed') return
    if (mode === 'fish' || mode === 'play' || mode === 'bubbles' || ((mode === 'desk' || mode === 'nap') && settleAction())) return
    const next = ['play', 'bubbles', 'fish', 'bubbles'] as const
    act(next[playTurn++ % next.length]!)
  }

  function bubbles() {
    if (!visible || mode !== 'idle' || activity.running) return
    act('bubbles')
  }

  function point(event: PointerEvent) {
    if (!visible || event.pointerType === 'touch') return
    lastInput = Date.now()
    pointer = { x: event.clientX, y: event.clientY }
    if (mode === 'nap' && !settleAction()) { react(); idle() }
  }

  function clearLook() { pointer = undefined }

  function click(event: MouseEvent) {
    const target = event.target
    if (!event.detail || event.button !== 0 || !(target instanceof win.Element) || target.closest(INTERACTIVE)
      || doc.getSelection()?.type === 'Range') return
    if (pet.popAt(event.clientX, event.clientY)) {
      react()
      if (mode === 'idle' || mode === 'bubbles') emote('happy', 1000)
      return
    }
    const { left, top, width, height } = mascot.getBoundingClientRect()
    if (!width || !height) return
    const x = (event.clientX - left) / width, y = (event.clientY - top) / height
    if (((x - .46) / .34) ** 2 + ((y - .52) / .36) ** 2 > 1) return
    lastInput = Date.now()
    const now = win.performance.now()
    taps = taps.filter(at => now - at < 1300)
    taps.push(now)
    if (taps.length >= 4 && mode !== 'working' && mode !== 'finishing') {
      taps = []
      if (!settleAction()) idle()
      react()
      emote('grumpy', 1750)
    } else if (((x - .48) / .115) ** 2 + ((y - .62) / .105) ** 2 < 1) feed()
    else play()
  }

  function draw(now: number) {
    raf = 0
    if (!visible) return
    raf = win.requestAnimationFrame(draw)
    const action = actions.draw(now)
    if (action.ended) {
      pet.stopFish()
      idle()
      if (activity.running) sync()
      else if (pendingFeed) feed()
    }
    const delta = lastFrame ? Math.min(80, now - lastFrame) : 16
    lastFrame = now
    const { left, top, width, height } = mascot.getBoundingClientRect()
    const dx = pointer ? pointer.x - left - width * .445 : 0
    const dy = pointer ? pointer.y - top - height * .415 : 0
    const distance = Math.hypot(dx, dy)
    const range = distance + Math.max(28, width * .15)
    const easing = 1 - Math.exp(-delta / 76)
    gazeX += (dx / range - gazeX) * easing
    gazeY += (dy / range - gazeY) * easing
    const closer = Boolean(pointer && width && distance < width * (near ? .86 : .69))
    if (closer !== near) {
      near = closer
      if (mode === 'idle') frame(near ? 'look' : 'idle')
    }
    const elapsed = now - poseSince
    const reactionAge = Math.max(0, (now - reactionSince) / 1000)
    const reaction = reactionAge > 2 ? 0 : Math.sin(reactionAge * 8) * Math.exp(-reactionAge * 4)
    const response = 1 - Math.exp(-delta / 47)
    const chewTarget = pose === 'chew' ? Math.sin(elapsed / (mode === 'feed' ? 390 : 320) * Math.PI) ** 2 : 0
    chew += (chewTarget - chew) * response
    const origin = character.draw({
      now, elapsed, face: pose, gazeX, gazeY, reaction, affect, food: BLUEFISH_MEALS[meal]!,
      chew, motion: action.motion,
    })
    if (action.emit && origin) pet.emit(action.emit, origin.x, origin.y, origin.direction)
    water.draw(now)
    remind(now)
  }

  const observer = typeof win.IntersectionObserver === 'function' ? new win.IntersectionObserver(([entry]) => {
    if (!entry || entry.isIntersecting === visible) return
    visible = entry.isIntersecting
    if (visible) { idle(); sync(); if (!raf) raf = win.requestAnimationFrame(draw) }
    else { clearLook(); pet.stopFish(); actions.reset(); pendingFeed = false; win.clearTimeout(timer); clearSpeech(); win.cancelAnimationFrame(raf); raf = 0; mode = 'idle' }
  }) : undefined
  observer?.observe(phase)
  win.addEventListener('pointermove', point, { passive: true, capture: true })
  win.addEventListener('blur', clearLook)
  doc.documentElement.addEventListener('pointerleave', clearLook)
  phase.addEventListener('click', click, { capture: true, passive: true })
  const preview = doc.body.hasAttribute('data-qyt-bluefish-preview')
  if (preview) {
    doc.addEventListener(BLUEFISH_FEED_EVENT, feed)
    doc.addEventListener(BLUEFISH_PLAY_EVENT, play)
    doc.addEventListener(BLUEFISH_BUBBLES_EVENT, bubbles)
  }
  idle()
  sync()
  raf = win.requestAnimationFrame(draw)

  return {
    sync,
    dispose() {
      win.clearTimeout(timer)
      win.clearTimeout(affectTimer)
      win.cancelAnimationFrame(raf)
      clearSpeech()
      observer?.disconnect()
      win.removeEventListener('pointermove', point, true)
      win.removeEventListener('blur', clearLook)
      doc.documentElement.removeEventListener('pointerleave', clearLook)
      phase.removeEventListener('click', click, true)
      doc.removeEventListener(BLUEFISH_FEED_EVENT, feed)
      doc.removeEventListener(BLUEFISH_PLAY_EVENT, play)
      doc.removeEventListener(BLUEFISH_BUBBLES_EVENT, bubbles)
      pet.dispose()
      character.dispose()
      actions.reset()
      water.dispose()
      speech.remove()
      mascot.remove()
    },
  }
}

/** Q Theme owns dynamic/static selection. Within dynamic mode we only animate
 * visible conversation surfaces. Static mode uses the approved illustration. */
export function installBluefishScene(doc: Document, ctx?: Context): () => void {
  const win = doc.defaultView
  if (!win?.matchMedia || !win.ResizeObserver) return () => {}
  const reduced = win.matchMedia('(prefers-reduced-motion: reduce)')
  const forced = win.matchMedia('(forced-colors: active)')
  const scenes = new Map<HTMLElement, ReturnType<typeof mountMascot>>()
  const reminders: Reminders = new Map()
  const language = () => (ctx?.locale?.getSnapshot?.().active ?? (doc.documentElement.lang || win.navigator.language)).startsWith('zh') ? zh : en
  function clear() {
    for (const scene of scenes.values()) scene.dispose()
    scenes.clear()
  }
  function sync() {
    if (doc.hidden || reduced.matches || forced.matches) { clear(); return }
    const phases = new Set(doc.querySelectorAll<HTMLElement>(PHASE))
    for (const [phase, scene] of scenes) {
      if (phases.has(phase)) scene.sync()
      else { scene.dispose(); scenes.delete(phase) }
    }
    for (const phase of phases) {
      if (!scenes.has(phase)) scenes.set(phase, mountMascot(phase, win!, reminders, language))
    }
  }
  const watched = PHASE + ',' + ACTIVITY
  const observer = new win.MutationObserver(records => {
    if (records.some(record => record.type === 'attributes' || [...record.addedNodes, ...record.removedNodes].some(
      node => node instanceof win!.Element && (node.matches(watched) || node.querySelector(watched) || scenes.has(node as HTMLElement)),
    ))) sync()
  })
  observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: [
    'data-qyt-bluefish-session', 'data-qyt-bluefish-running', 'data-qyt-bluefish-started', 'data-qyt-bluefish-outcome',
    'data-qyt-bluefish-demo', 'data-qyt-bluefish-demo-started',
  ] })
  reduced.addEventListener('change', sync)
  forced.addEventListener('change', sync)
  doc.addEventListener('visibilitychange', sync)
  sync()
  return () => {
    observer.disconnect()
    reduced.removeEventListener('change', sync)
    forced.removeEventListener('change', sync)
    doc.removeEventListener('visibilitychange', sync)
    clear()
  }
}
