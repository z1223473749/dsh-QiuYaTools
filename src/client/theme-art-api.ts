import type { Context } from '@deepseek-ai/cordis'
import type { QThemeId, ThemeMotion } from '../shared.ts'
import { THEME_ART_CHANNEL, THEME_ART_FILES, THEME_ART_METHOD, THEME_ART_PRESETS } from '../theme-art.ts'
import type { ThemeDefinition } from './theme-catalog.ts'

type ArtFile = keyof typeof THEME_ART_FILES
type ArtParts = { scene: ArtFile; sidebar?: ArtFile; plate?: ArtFile }
type Entry = { status: 'loading' | 'failed' } | { status: 'ready'; data: string }
const entries = new Map<ArtFile, Entry>()
const listeners = new Set<() => void>()
let version = 0

export const themeArtVersion = () => version
export function subscribeThemeArt(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function partsFor(id: QThemeId): ArtParts | undefined {
  return Object.hasOwn(THEME_ART_PRESETS, id) ? THEME_ART_PRESETS[id as keyof typeof THEME_ART_PRESETS] : undefined
}

function requiredParts(id: QThemeId, motion: ThemeMotion): ArtFile[] {
  const parts = partsFor(id)
  return parts ? [parts.scene, ...(parts.sidebar ? [parts.sidebar] : []), ...(motion === 'dynamic' && parts.plate ? [parts.plate] : [])] : []
}

export function themeArtFailed(id: QThemeId, motion: ThemeMotion): boolean {
  return requiredParts(id, motion).some(file => entries.get(file)?.status === 'failed')
}

export function ensureThemeArt(ctx: Context, id: QThemeId, motion: ThemeMotion, retry = false): void {
  const connection = ctx?.get?.('connection') as { rpc?: { call(channel: string, method: string, payload: object): Promise<{ ok: boolean; value?: unknown }> } } | undefined
  const rpc = connection?.rpc
  if (!rpc) return
  for (const file of requiredParts(id, motion)) {
    const entry = entries.get(file)
    if (entry && !(retry && entry.status === 'failed')) continue
    entries.set(file, { status: 'loading' })
    void (async () => {
      const artifact = THEME_ART_FILES[file]
      try {
        const result = await rpc.call(THEME_ART_CHANNEL, THEME_ART_METHOD, { id: file })
        if (!result.ok || typeof result.value !== 'string' || result.value.length !== Math.ceil(artifact.bytes / 3) * 4) throw new Error('art-unavailable')
        entries.set(file, { status: 'ready', data: `data:${artifact.mime};base64,${result.value}` })
      } catch { entries.set(file, { status: 'failed' }) }
      version++
      for (const listener of [...listeners]) listener()
    })()
  }
}

export function resolveThemeArt(theme: ThemeDefinition): ThemeDefinition {
  const parts = partsFor(theme.id)
  if (!parts) return theme
  const read = (file?: ArtFile) => {
    const entry = file && entries.get(file)
    return entry && entry.status === 'ready' ? entry.data : undefined
  }
  const scene = read(parts.scene), sidebar = read(parts.sidebar), plate = read(parts.plate)
  const installLayeredScene = theme.installLayeredScene
  const layeredReady = Boolean(installLayeredScene && scene && plate)
  return {
    ...theme,
    art: scene ?? theme.art,
    sidebarArt: sidebar ?? theme.sidebarArt,
    revision: `${!!scene}:${!!sidebar}`,
    sceneRevision: installLayeredScene ? String(layeredReady) : 'preset',
    installScene: installLayeredScene
      ? scene && plate ? doc => installLayeredScene(doc, scene, plate) : undefined
      : theme.installScene,
  }
}
