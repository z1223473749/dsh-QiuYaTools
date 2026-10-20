export const SETTINGS_ID = 'qiuya-tools'

/** Serialized values projected by the Host configuration form. */
export interface Preferences {
  /** Legacy master switch, retained so an existing paused profile stays paused. */
  enabled: boolean
  pastedTextEnabled: boolean
  sessionWindowsEnabled: boolean
  bulkArchiveEnabled: boolean
  planCommentsEnabled: boolean
  sidebarToolsEnabled: boolean
  promptSuggestionsEnabled: boolean
  /** Appearance is independent of the enhancement tools and their legacy master. */
  qThemeEnabled: boolean
  computerUseEnabled: boolean
  pasteCharacterThreshold: number
  pasteLineThreshold: number
}

export const FEATURE_FIELDS = [
  'pastedTextEnabled', 'sessionWindowsEnabled', 'bulkArchiveEnabled', 'planCommentsEnabled', 'sidebarToolsEnabled', 'promptSuggestionsEnabled',
] as const
export type FeatureField = typeof FEATURE_FIELDS[number]

export const DEFAULT_PREFERENCES: Readonly<Preferences> = Object.freeze({
  enabled: true,
  pastedTextEnabled: true,
  sessionWindowsEnabled: true,
  bulkArchiveEnabled: true,
  planCommentsEnabled: true,
  sidebarToolsEnabled: true,
  promptSuggestionsEnabled: true,
  qThemeEnabled: false,
  computerUseEnabled: false,
  pasteCharacterThreshold: 1000,
  pasteLineThreshold: 15,
})

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
