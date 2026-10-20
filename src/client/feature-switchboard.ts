import type { FeatureField, Preferences } from '../shared.ts'
import { FEATURE_FIELDS, isFeatureEnabled } from '../shared.ts'

/** Serialize teardown and activation so quick setting changes never leave duplicate listeners. */
export class FeatureSwitchboard {
  private readonly active = new Map<FeatureField, () => void | Promise<void>>()
  private pending = Promise.resolve()
  private closed = false
  private disposeTask: Promise<void> | undefined

  constructor(private readonly start: (field: FeatureField) => (() => void | Promise<void>)) {}

  update(preferences: Partial<Preferences> | undefined): Promise<void> {
    this.pending = this.pending.catch(() => {}).then(async () => {
      if (this.closed) return
      for (const field of FEATURE_FIELDS) {
        if (this.closed) return
        const enabled = preferences !== undefined && isFeatureEnabled(preferences, field)
        const stop = this.active.get(field)
        if (!enabled && stop !== undefined) { await stop(); this.active.delete(field) }
        if (this.closed) return
        if (enabled && stop === undefined) this.active.set(field, this.start(field))
      }
    })
    return this.pending
  }

  dispose(): Promise<void> {
    if (this.disposeTask !== undefined) return this.disposeTask
    this.closed = true
    this.disposeTask = (async () => {
      await this.pending.catch(() => {})
      const stops = [...this.active.values()].reverse()
      this.active.clear()
      await Promise.allSettled(stops.map(stop => Promise.resolve().then(stop)))
    })()
    return this.disposeTask
  }
}
