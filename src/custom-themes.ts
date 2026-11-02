/** Small self-contained images persist with the active Host profile. No blob
 * URL, browser-local cache or remote image service is needed on reload. */
export const MAX_CUSTOM_THEMES = 8
export const MAX_THEME_IMAGE_BYTES = 256 * 1024
export const CUSTOM_THEME_ID = /^custom:[a-z0-9-]{1,48}$/
export const THEME_IMAGE = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/
export interface CustomTheme {
  id: `custom:${string}`
  name: string
  image: string
  width: number
  height: number
  accent: string
  motion: 'dynamic' | 'static'
  movement: 'parallax' | 'pan' | 'none'
  atmosphere: 'glow' | 'petals' | 'snow' | 'none'
  intensity: number
  speed: number
  x: number
  y: number
  zoom: number
  mask: number
}
const range = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
export function isCustomTheme(value: unknown): value is CustomTheme {
  if (!value || typeof value !== 'object') return false
  const v = value as CustomTheme
  return typeof v.id === 'string' && CUSTOM_THEME_ID.test(v.id)
    && typeof v.name === 'string' && v.name.trim().length > 0 && v.name.length <= 40
    && typeof v.image === 'string' && v.image.length <= Math.ceil(MAX_THEME_IMAGE_BYTES / 3) * 4 + 40 && THEME_IMAGE.test(v.image)
    && range(v.width, 1, 1600) && range(v.height, 1, 1600)
    && typeof v.accent === 'string' && /^#[a-f0-9]{6}$/i.test(v.accent)
    && ['dynamic', 'static'].includes(v.motion) && ['parallax', 'pan', 'none'].includes(v.movement)
    && ['glow', 'petals', 'snow', 'none'].includes(v.atmosphere)
    && range(v.intensity, 0, 1) && range(v.speed, .1, 2) && range(v.x, 0, 100) && range(v.y, 0, 100)
    && range(v.zoom, 1, 2) && range(v.mask, .5, 1)
}
export function getCustomThemes(preferences?: { qCustomThemes?: unknown }): CustomTheme[] {
  if (!Array.isArray(preferences?.qCustomThemes)) return []
  const seen = new Set<string>()
  return preferences.qCustomThemes.filter((v): v is CustomTheme => {
    if (!isCustomTheme(v) || seen.has(v.id)) return false
    seen.add(v.id); return true
  }).slice(0, MAX_CUSTOM_THEMES)
}
