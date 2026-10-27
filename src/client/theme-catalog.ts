import { Q_THEME_IDS, type QThemeId } from '../shared.ts'
import type { LocaleKey } from './locales.ts'
import { OCEAN_SCENE_DATA_URL, BEGONIA_SCENE_DATA_URL } from './brand-assets.ts'
import { installOceanScene } from './ocean-scene.ts'
import { installBegoniaScene } from './begonia-scene.ts'
import oceanPalette from './themes/ocean.css'
import begoniaPalette from './themes/begonia.css'

/** A theme supplies art, colors and an optional motion adapter. The settings,
 * reading surfaces and installation lifecycle belong to the common framework. */
export interface ThemeDefinition {
  readonly id: QThemeId
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

const definitions: Readonly<Record<QThemeId, ThemeDefinition>> = {
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
}

export const Q_THEMES: readonly ThemeDefinition[] = Q_THEME_IDS.map(id => definitions[id])

export function getQTheme(id: QThemeId): ThemeDefinition {
  return definitions[id] ?? definitions.ocean
}
