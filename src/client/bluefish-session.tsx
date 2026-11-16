import { useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { DEFAULT_PREFERENCES, getQThemeId, getThemeMotion, type Preferences } from '../shared.ts'

/** Publish only the mounted pane's activity and turn outcome, without copying
 * prompts or coupling the animation to streamed chat DOM. */
export function installBluefishSession(ctx: Context, form: ConfigForm<Preferences>): () => void {
  function enabled() {
    const snapshot = form.getSnapshot()
    return snapshot.status === 'ready' && (snapshot.value?.qThemeEnabled ?? DEFAULT_PREFERENCES.qThemeEnabled)
      && getQThemeId(snapshot.value) === 'bluefish' && getThemeMotion(snapshot.value, 'bluefish') === 'dynamic'
  }

  function BluefishSession({ sessionId, useSession }: PropsRuntime<'conversation.input.overlay'>) {
    const active = useSyncExternalStore(listener => form.subscribe(listener), enabled, enabled)
    const running = useSession(session => session.running && !session.removed)
    const anchor = useRef<HTMLSpanElement>(null)
    const binding = active ? ctx.sessions.binding(sessionId) : undefined
    useLayoutEffect(() => {
      const node = anchor.current
      if (!node || !binding) return
      if (!running) { delete node.dataset.qytBluefishStarted; return }
      if (node.dataset.qytBluefishStarted) return
      const { entries } = binding.eventSource.getSnapshot()
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i]
        if (entry?.type !== 'event') continue
        if (entry.event.type === 'turn/start') { node.dataset.qytBluefishStarted = String(entry.event.time); return }
        if (entry.event.type === 'turn/end') break
      }
      node.dataset.qytBluefishStarted = String(Date.now())
    }, [binding, running])
    useLayoutEffect(() => {
      const node = anchor.current
      if (!node || !binding) return
      let observed = binding.eventSource.getSnapshot().revision
      return binding.eventSource.subscribe(() => {
        const { revision, change } = binding.eventSource.getSnapshot()
        if (revision === observed) return
        observed = revision
        if (change.kind !== 'append') return
        for (const entry of change.entries) {
          if (entry.type !== 'event') continue
          if (entry.event.type === 'turn/start') delete node.dataset.qytBluefishOutcome
          if (entry.event.type === 'turn/end') node.dataset.qytBluefishOutcome = entry.event.data.reason.kind
        }
      })
    }, [binding])
    return active ? <span key={sessionId} ref={anchor} hidden data-qyt-bluefish-session={sessionId} data-qyt-bluefish-running={running} /> : null
  }

  return ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
    name: 'conversation.input.overlay', id: 'qiuya-tools-bluefish-session', order: 120,
  }, BluefishSession))
}
