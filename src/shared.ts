export const SETTINGS_ID = 'qiuya-tools'

export const Q_THEME_IDS = ['ocean', 'begonia'] as const
export type QThemeId = typeof Q_THEME_IDS[number]
export type ThemeMotion = 'dynamic' | 'static'
/** Kept for existing Ocean consumers. */
export type OceanMotion = ThemeMotion
export type QThemeSettings = Record<QThemeId, { motion: ThemeMotion }>
export const DEFAULT_Q_THEME_SETTINGS: QThemeSettings = Object.freeze({
  ocean: Object.freeze({ motion: 'dynamic' }),
  begonia: Object.freeze({ motion: 'dynamic' }),
})

/** Serialized values projected by the Host configuration form. */
export interface Preferences {
  /** Legacy master switch, retained so an existing paused profile stays paused. */
  enabled: boolean
  pastedTextEnabled: boolean
  sessionWindowsEnabled: boolean
  bulkArchiveEnabled: boolean
  planCommentsEnabled: boolean
  conversationCommentsEnabled: boolean
  sidebarToolsEnabled: boolean
  promptSuggestionsEnabled: boolean
  gitEnabled: boolean
  /** Appearance is independent of the enhancement tools and their legacy master. */
  qThemeEnabled: boolean
  /** Missing or unknown ids retain Ocean when upgrading an older profile. */
  qThemeId: QThemeId
  /** Each theme owns its options; changing one leaves the others intact. */
  qThemeSettings: QThemeSettings
  computerUseEnabled: boolean
  /** Background checks only; installation always requires an explicit action. */
  autoCheckUpdates: boolean
  pasteCharacterThreshold: number
  pasteLineThreshold: number
}

export const FEATURE_FIELDS = [
  'pastedTextEnabled', 'sessionWindowsEnabled', 'bulkArchiveEnabled', 'planCommentsEnabled', 'conversationCommentsEnabled', 'sidebarToolsEnabled', 'promptSuggestionsEnabled', 'gitEnabled',
] as const
export type FeatureField = typeof FEATURE_FIELDS[number]

export const DEFAULT_PREFERENCES: Readonly<Preferences> = Object.freeze({
  enabled: true,
  pastedTextEnabled: true,
  sessionWindowsEnabled: true,
  bulkArchiveEnabled: true,
  planCommentsEnabled: true,
  conversationCommentsEnabled: true,
  sidebarToolsEnabled: true,
  promptSuggestionsEnabled: true,
  gitEnabled: true,
  qThemeEnabled: true,
  qThemeId: 'ocean',
  qThemeSettings: DEFAULT_Q_THEME_SETTINGS,
  computerUseEnabled: false,
  autoCheckUpdates: true,
  pasteCharacterThreshold: 1000,
  pasteLineThreshold: 15,
})

/** Treat saved data as untrusted: old and unknown themes fall back to Ocean. */
export function getQThemeId(preferences: Partial<Preferences> | undefined): QThemeId {
  return Q_THEME_IDS.find(id => id === preferences?.qThemeId) ?? 'ocean'
}

/** Every theme has an independent motion setting, including legacy profiles. */
export function getThemeMotion(preferences: Partial<Preferences> | undefined, id = getQThemeId(preferences)): ThemeMotion {
  return preferences?.qThemeSettings?.[id]?.motion === 'static' ? 'static' : 'dynamic'
}

export function getOceanMotion(preferences: Partial<Preferences> | undefined): OceanMotion {
  return getThemeMotion(preferences, 'ocean')
}

/** Missing feature fields inherit the defaults when upgrading an older profile. */
export function isFeatureEnabled(preferences: Partial<Preferences> | undefined, field: FeatureField): boolean {
  return preferences?.enabled !== false && preferences?.[field] !== false
}

export function allFeaturesEnabled(preferences: Partial<Preferences> | undefined): boolean {
  return FEATURE_FIELDS.every(field => isFeatureEnabled(preferences, field))
}

/** Draft number fields stay strings until the user explicitly saves both limits. */
export function parsePasteThreshold(value: string, kind: 'characters' | 'lines'): number | undefined {
  if (!/^\d+$/.test(value)) return undefined
  const number = Number(value)
  const max = kind === 'characters' ? 1_000_000 : 100_000
  return Number.isSafeInteger(number) && number >= 1 && number <= max ? number : undefined
}
