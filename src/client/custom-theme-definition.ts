import type { CustomTheme } from '../custom-themes.ts'
import type { ThemeDefinition } from './theme-catalog.ts'
import { installLandscapeScene } from './landscape-scene.ts'
import basePalette from './themes/sunset.css'
function mix(hex: string, target: number, weight: number): string {
  return '#' + [1, 3, 5].map(start => Math.round(parseInt(hex.slice(start, start + 2), 16) * (1 - weight) + target * weight).toString(16).padStart(2, '0')).join('')
}
export function createCustomTheme(theme: CustomTheme): ThemeDefinition {
  const selector = `body[data-qyt-q-theme="${theme.id}"]`
  // Keep button and label contrast legible even if the chosen seed is very pale.
  const luminance = (hex: string): number => [1, 3, 5].map(start => {
    const channel = parseInt(hex.slice(start, start + 2), 16) / 255
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4
  }).reduce((sum, channel, i) => sum + channel * [.2126, .7152, .0722][i], 0)
  let accent = theme.accent
  while (luminance(accent) > .18) accent = mix(accent, 0, .06)
  const dark = mix(theme.accent, 255, .6), position = `${theme.x}% ${theme.y}%`
  const palette = basePalette.replaceAll('"sunset"', `"${theme.id}"`).replaceAll('#ad563e', accent).replaceAll('#f4b393', dark) + `
${selector}{--qyt-q-accent-hover:${mix(accent, 0, .15)};--qyt-q-selected:${mix(accent, 255, .84)};--qyt-q-paper:rgba(255,250,245,${theme.mask});--qyt-q-focus-line:${accent};--qyt-q-sidebar-art-position:${position};}
${selector}[data-ds-dark-theme]{--qyt-q-selected:${mix(accent, 0, .6)};--qyt-q-accent-hover:${mix(dark, 255, .2)};--qyt-q-paper:rgba(36,29,28,${Math.max(.85, theme.mask)});}
${selector} [data-slot="main.conversation"] > [data-phase]{background-position:center,center,center,${position};--qyt-q-canvas-size:100% 100%,100% 100%,100% 100%,max(${theme.zoom * 100}vw,${theme.zoom * 100 * theme.width / theme.height}vh) auto;}
`
  return { id: theme.id, name: 'qThemeCustom', displayName: theme.name, description: 'qThemeCustomDescription', hint: 'qThemeCustomHint',
    motionLabel: 'qThemeCustomMotion', label: 'Q Custom', art: theme.image, accent, accentDark: dark, soft: theme.accent,
    previewPosition: position, bannerPosition: position, palette,
    revision: JSON.stringify(theme),
    installScene: doc => installLandscapeScene(doc, { ...theme, position }),
  }
}
