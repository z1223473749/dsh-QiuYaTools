export const SETTINGS_ID = 'qiuya-tools'

export type OceanMotion = 'dynamic' | 'static'
export interface QThemeSettings {
  ocean: { motion: OceanMotion }
}
export const DEFAULT_Q_THEME_SETTINGS: QThemeSettings = Object.freeze({
  ocean: Object.freeze({ motion: 'dynamic' }),
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
  /** Each theme owns its options; Ocean motion does not affect other themes. */
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
  qThemeEnabled: false,
  qThemeSettings: DEFAULT_Q_THEME_SETTINGS,
  computerUseEnabled: false,
  autoCheckUpdates: true,
  pasteCharacterThreshold: 1000,
  pasteLineThreshold: 15,
})

/** Older profiles retain Ocean's dynamic default when theme options are absent. */
export function getOceanMotion(preferences: Partial<Preferences> | undefined): OceanMotion {
  return preferences?.qThemeSettings?.ocean?.motion === 'static' ? 'static' : 'dynamic'
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
