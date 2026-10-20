import { MONO_ICON_DATA_URL } from './brand-assets.ts'

/** One transparent silhouette follows the text color in both menu surfaces. */
export function createMenuBrandIcon(doc: Document, size = 18): HTMLSpanElement {
  const icon = doc.createElement('span')
  icon.dataset.qytBrandIcon = 'true'
  icon.setAttribute('aria-hidden', 'true')
  Object.assign(icon.style, {
    display: 'inline-block', width: `${size}px`, height: `${size}px`, flexShrink: '0',
    backgroundColor: 'currentColor', maskImage: `url("${MONO_ICON_DATA_URL}")`,
    maskSize: 'contain', maskRepeat: 'no-repeat', maskPosition: 'center', maskMode: 'alpha',
    webkitMaskImage: `url("${MONO_ICON_DATA_URL}")`, webkitMaskSize: 'contain',
    webkitMaskRepeat: 'no-repeat', webkitMaskPosition: 'center',
  })
  return icon
}
