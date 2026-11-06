import type { Context } from '@deepseek-ai/cordis'
import { getCustomThemes } from '../custom-themes.ts'
import { createCustomTheme } from './custom-theme-definition.ts'
import { DEFAULT_Q_THEME_ID, Q_THEME_IDS, type QThemeId, type QPresetThemeId, type Preferences } from '../shared.ts'
import type { LocaleKey } from './locales.ts'
import { OCEAN_SCENE_DATA_URL, BEGONIA_SCENE_DATA_URL, SUNSET_SCENE_DATA_URL, MOONFROST_SCENE_DATA_URL, BULIANGREN_SCENE_DATA_URL } from './brand-assets.ts'
import { installOceanScene } from './ocean-scene.ts'
import { installBegoniaScene } from './begonia-scene.ts'
import { installLandscapeScene } from './landscape-scene.ts'
import { installMoonfrostScene } from './moonfrost-scene.ts'
import { installBuliangrenScene } from './buliangren-scene.ts'
import { loadThemeVideo } from './theme-video-api.ts'
import { installVideoScene, type SceneDisposer } from './video-scene.ts'
import { FOX_SCENE_DATA_URL, FOX_SIDEBAR_DATA_URL, GARO_SCENE_DATA_URL, GARO_SIDEBAR_DATA_URL } from './brand-assets.ts'
import foxPalette from './themes/fox.css'
import garoPalette from './themes/garo.css'
import sunsetPalette from './themes/sunset.css'
import oceanPalette from './themes/ocean.css'
import begoniaPalette from './themes/begonia.css'
import moonfrostPalette from './themes/moonfrost.css'
import buliangrenPalette from './themes/buliangren.css'

/** A theme supplies art, colors and an optional motion adapter. The settings,
 * reading surfaces and installation lifecycle belong to the common framework. */
export interface ThemeDefinition {
  readonly id: QThemeId
  readonly displayName?: string
  readonly video?: boolean
  readonly revision?: string
  readonly sceneRevision?: string
  readonly name: LocaleKey
  readonly description: LocaleKey
  readonly hint?: LocaleKey
  readonly motionLabel: LocaleKey
  readonly label: string
  readonly art: string
  readonly sidebarArt?: string
  readonly sidebarZoom?: { factor: number; aspect: number }
  readonly accent: string
  readonly accentDark: string
  readonly soft: string
  /** Art-specific crops for shared settings surfaces. */
  readonly bannerPosition?: string
  readonly previewPosition?: string
  readonly palette: string
  readonly installLayeredScene?: (doc: Document, art: string, plate: string) => SceneDisposer
  readonly installScene?: (doc: Document, ctx?: Context) => SceneDisposer
}

const definitions: Readonly<Record<QPresetThemeId, ThemeDefinition>> = {
  garo: {
    id: 'garo', video: true, name: 'qThemeGaro', description: 'qThemeGaroDescription',
    motionLabel: 'qThemeGaroMotion', label: 'Q Garo · 伽罗 · 月下冰弦',
    art: GARO_SCENE_DATA_URL, sidebarArt: GARO_SIDEBAR_DATA_URL, accent: '#226584', accentDark: '#96d5ec', soft: '#b4d7e8',
    bannerPosition: 'center', previewPosition: 'center',
    palette: moonfrostPalette.replaceAll('data-qyt-q-theme="moonfrost"', 'data-qyt-q-theme="garo"') + garoPalette,
    installScene: (doc, ctx) => installVideoScene(doc, { source: signal => loadThemeVideo(ctx!, 'garo', signal), poster: GARO_SCENE_DATA_URL }),
  },
  fox: {
    id: 'fox', video: true, name: 'qThemeFox', description: 'qThemeFoxDescription',
    motionLabel: 'qThemeFoxMotion', label: 'Q Fox · 桃华白狐',
    art: FOX_SCENE_DATA_URL, sidebarArt: FOX_SIDEBAR_DATA_URL, accent: '#985c7a', accentDark: '#efbdd8', soft: '#e5bbd0',
    bannerPosition: 'center', previewPosition: 'center', palette: foxPalette,
    installScene: (doc, ctx) => installVideoScene(doc, { source: signal => loadThemeVideo(ctx!, 'fox', signal), poster: FOX_SCENE_DATA_URL }),
  },
  ocean: {
    id: 'ocean', name: 'qThemePreview', description: 'qThemePreviewDescription',
    hint: 'qThemePreviewHint', motionLabel: 'qThemeOceanMotion', label: 'Q Ocean · 鲸与海',
    art: OCEAN_SCENE_DATA_URL, accent: '#116d83', accentDark: '#8ec6d2', soft: '#90bfb3',
    palette: oceanPalette, installLayeredScene: installOceanScene,
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
    installLayeredScene: installMoonfrostScene,
  },
  buliangren: {
    id: 'buliangren', name: 'qThemeBuliangren', description: 'qThemeBuliangrenDescription',
    hint: 'qThemeBuliangrenHint', motionLabel: 'qThemeBuliangrenMotion', label: 'Q Buliangren · 不良人 · 玄冥夜行',
    art: BULIANGREN_SCENE_DATA_URL, accent: '#82602e', accentDark: '#d1b078', soft: '#b67863',
    bannerPosition: 'right top', previewPosition: 'right top',
    palette: buliangrenPalette, installLayeredScene: installBuliangrenScene,
  },
}

export const Q_THEMES: readonly ThemeDefinition[] = Q_THEME_IDS.map(id => definitions[id])

export function getQThemes(preferences?: Partial<Preferences>): readonly ThemeDefinition[] {
  return [...Q_THEMES, ...getCustomThemes(preferences).map(theme => createCustomTheme(theme))]
}

export function getQTheme(id: QThemeId, preferences?: Partial<Preferences>): ThemeDefinition {
  if (id.startsWith('custom:')) {
    const theme = getCustomThemes(preferences).find(theme => theme.id === id)
    return theme ? createCustomTheme(theme) : definitions[DEFAULT_Q_THEME_ID]
  }
  return definitions[id as QPresetThemeId] ?? definitions[DEFAULT_Q_THEME_ID]
}
