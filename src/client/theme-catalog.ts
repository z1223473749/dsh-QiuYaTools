import { getCustomThemes } from '../custom-themes.ts'
import { createCustomTheme } from './custom-theme-definition.ts'
import { DEFAULT_Q_THEME_ID, Q_THEME_IDS, type QThemeId, type QPresetThemeId, type Preferences } from '../shared.ts'
import type { LocaleKey } from './locales.ts'
import { OCEAN_SCENE_DATA_URL, BEGONIA_SCENE_DATA_URL, SUNSET_SCENE_DATA_URL, MOONFROST_SCENE_DATA_URL } from './brand-assets.ts'
import { installOceanScene } from './ocean-scene.ts'
import { installBegoniaScene } from './begonia-scene.ts'
import { installLandscapeScene } from './landscape-scene.ts'
import { installMoonfrostScene } from './moonfrost-scene.ts'
import sunsetPalette from './themes/sunset.css'
import oceanPalette from './themes/ocean.css'
import begoniaPalette from './themes/begonia.css'
import moonfrostPalette from './themes/moonfrost.css'

/** A theme supplies art, colors and an optional motion adapter. The settings,
 * reading surfaces and installation lifecycle belong to the common framework. */
export interface ThemeDefinition {
  readonly id: QThemeId
  readonly displayName?: string
  readonly revision?: string
  readonly name: LocaleKey
  readonly description: LocaleKey
  readonly hint: LocaleKey
  readonly motionLabel: LocaleKey
  readonly label: string
  readonly art: string
  readonly accent: string
  readonly accentDark: string
  readonly soft: string
  /** Art-specific crops for shared settings surfaces. */
  readonly bannerPosition?: string
  readonly previewPosition?: string
  readonly palette: string
  readonly installScene?: (doc: Document) => () => void
}

const definitions: Readonly<Record<QPresetThemeId, ThemeDefinition>> = {
  ocean: {
    id: 'ocean', name: 'qThemePreview', description: 'qThemePreviewDescription',
    hint: 'qThemePreviewHint', motionLabel: 'qThemeOceanMotion', label: 'Q Ocean · 鲸与海',
    art: OCEAN_SCENE_DATA_URL, accent: '#116d83', accentDark: '#8ec6d2', soft: '#90bfb3',
    palette: oceanPalette, installScene: installOceanScene,
  },
  begonia: {
    id: 'begonia', name: 'qThemeBegonia', description: 'qThemeBegoniaDescription',
    hint: 'qThemeBegoniaHint', motionLabel: 'qThemeBegoniaMotion', label: 'Q Begonia · 大鱼海棠',
    art: BEGONIA_SCENE_DATA_URL, accent: '#bc353c', accentDark: '#f0a2a6', soft: '#e4a4a3',
    bannerPosition: 'right 38%', previewPosition: 'right 25%',
    palette: begoniaPalette, installScene: installBegoniaScene,
  },
  sunset: {
    id: 'sunset', name: 'qThemeSunset', description: 'qThemeSunsetDescription',
    hint: 'qThemeSunsetHint', motionLabel: 'qThemeSunsetMotion', label: 'Q Sunset · 落日山野',
    art: SUNSET_SCENE_DATA_URL, accent: '#ad563e', accentDark: '#f4b393', soft: '#e8b78a',
    bannerPosition: 'right 62%', previewPosition: 'center 62%',
    palette: sunsetPalette, installScene: doc => installLandscapeScene(doc),
  },
  moonfrost: {
    id: 'moonfrost', name: 'qThemeMoonfrost', description: 'qThemeMoonfrostDescription',
    hint: 'qThemeMoonfrostHint', motionLabel: 'qThemeMoonfrostMotion', label: 'Q Moonfrost · 月阙清霜',
    art: MOONFROST_SCENE_DATA_URL, accent: '#456493', accentDark: '#b4c9ee', soft: '#b7c8e4',
    bannerPosition: 'right top', previewPosition: 'right top',
    palette: moonfrostPalette,
    installScene: installMoonfrostScene,
  },
}

export const Q_THEMES: readonly ThemeDefinition[] = Q_THEME_IDS.map(id => definitions[id])

export function getQThemes(preferences?: Partial<Preferences>): readonly ThemeDefinition[] {
  return [...Q_THEMES, ...getCustomThemes(preferences).map(createCustomTheme)]
}

export function getQTheme(id: QThemeId, preferences?: Partial<Preferences>): ThemeDefinition {
  if (id.startsWith('custom:')) {
    const theme = getCustomThemes(preferences).find(theme => theme.id === id)
    return theme ? createCustomTheme(theme) : definitions[DEFAULT_Q_THEME_ID]
  }
  return definitions[id as QPresetThemeId] ?? definitions[DEFAULT_Q_THEME_ID]
}
