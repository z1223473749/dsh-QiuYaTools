import { isSmartMotion, type SmartMotion } from './smart-motion.ts'
import { LOCAL_VIDEO_ID } from './theme-video.ts'
/** Small self-contained images persist with the active Host profile. No blob
 * URL, browser-local cache or remote image service is needed on reload. */
export const MAX_CUSTOM_THEMES = 8
export const MAX_THEME_IMAGE_BYTES = 256 * 1024
export const CUSTOM_THEME_ID = /^custom:[a-z0-9-]{1,48}$/
export const THEME_IMAGE = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/
export const THEME_MOVEMENTS = ['parallax', 'pan', 'breathe', 'float', 'orbit', 'none'] as const
export const THEME_ATMOSPHERES = ['glow', 'petals', 'snow', 'fireflies', 'stars', 'bubbles', 'aurora', 'none'] as const
export type ThemeMovement = typeof THEME_MOVEMENTS[number]
export type ThemeAtmosphere = typeof THEME_ATMOSPHERES[number]
export const ATMOSPHERE_COLORS: Record<ThemeAtmosphere, string> = {
  glow: '#ffe4a3', petals: '#f5b5cd', snow: '#e5f3ff', fireflies: '#bdffb0',
  stars: '#d5dcff', bubbles: '#b7eaff', aurora: '#8ce8d2', none: '#e5f3ff',
}
export interface CustomTheme {
  id: `custom:${string}`
  name: string
  image: string
  width: number
  height: number
  accent: string
  motion: 'dynamic' | 'static'
  movement: ThemeMovement
  atmosphere: ThemeAtmosphere
  /** Omitted in older themes; each effect then uses its own soft palette. */
  atmosphereColor?: string
  smartMotion?: SmartMotion
  video?: {
    assetId: string
    sound: boolean
    sidebar: 'video' | 'cover'
    x: number
    y: number
    zoom?: number
    frame: number
    /** Original cover color, stored when a manual theme color is selected. */
    coverAccent?: string
  }
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
    && ['dynamic', 'static'].includes(v.motion) && THEME_MOVEMENTS.includes(v.movement)
    && THEME_ATMOSPHERES.includes(v.atmosphere)
    && (v.atmosphereColor === undefined || (typeof v.atmosphereColor === 'string' && /^#[a-f0-9]{6}$/i.test(v.atmosphereColor)))
    && (v.smartMotion === undefined || isSmartMotion(v.smartMotion))
    && (v.video === undefined || (v.video !== null && typeof v.video === 'object' && !v.smartMotion
      && typeof v.video.assetId === 'string' && LOCAL_VIDEO_ID.test(v.video.assetId)
      && typeof v.video.sound === 'boolean' && (v.video.sidebar === 'video' || v.video.sidebar === 'cover')
      && range(v.video.x, 0, 100) && range(v.video.y, 0, 100) && Number.isFinite(v.video.frame) && v.video.frame >= 0
      && (v.video.zoom === undefined || range(v.video.zoom, 1, 2))
      && (v.video.coverAccent === undefined || (typeof v.video.coverAccent === 'string' && /^#[a-f0-9]{6}$/i.test(v.video.coverAccent)))))
    && range(v.intensity, 0, 1) && range(v.speed, .1, 5) && range(v.x, 0, 100) && range(v.y, 0, 100)
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
