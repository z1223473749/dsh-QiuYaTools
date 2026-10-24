export interface WorkbenchFloatRect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

/** Public Dockkit coordinates are CSS pixels. This only proposes a first-float rectangle. */
export function workbenchFloatRect(viewport: { width: number; height: number }): WorkbenchFloatRect | undefined {
  const { width: availableWidth, height: availableHeight } = viewport
  if (!Number.isFinite(availableWidth) || !Number.isFinite(availableHeight) || availableWidth <= 0 || availableHeight <= 0) return undefined
  const margin = Math.min(16, availableWidth / 20, availableHeight / 20)
  const width = Math.min(700, availableWidth - margin * 2)
  const height = Math.min(520, availableHeight - margin * 2)
  return { x: (availableWidth - width) / 2, y: (availableHeight - height) / 2, width, height }
}
