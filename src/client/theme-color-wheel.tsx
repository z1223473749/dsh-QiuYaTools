import React, { useEffect, useId, useState } from 'react'
import type { LocaleKey } from './locales.ts'

export function hsvToHex(h: number, s: number, v: number): string {
  const channel = (n: number) => {
    const k = (n + h / 60) % 6
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255).toString(16).padStart(2, '0')
  }
  return `#${channel(5)}${channel(3)}${channel(1)}`
}
export function hexToHsv(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16) / 255)
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
  const h = !d ? 0 : max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h * 60, max ? d / max : 0, max]
}
const SWATCHES = ['#ffe4a3', '#f5b5cd', '#e5f3ff', '#bdffb0', '#d5dcff', '#8ce8d2']
export function ThemeColorWheel({ value, automatic, disabled, t, onChange, onReset }: {
  value: string; automatic: boolean; disabled: boolean; t(key: LocaleKey): string
  onChange(color: string): void; onReset(): void
}) {
  const id = useId(), [hsv, setHsv] = useState(() => hexToHsv(value)), [hex, setHex] = useState<string | null>(null)
  useEffect(() => {
    setHsv(current => hsvToHex(...current).toLowerCase() === value.toLowerCase() ? current : hexToHsv(value))
  }, [value])
  function update(next: [number, number, number]) { const color = hsvToHex(...next); setHsv(next); setHex(null); onChange(color) }
  function pick(event: React.PointerEvent<HTMLDivElement>) {
    if (disabled) return
    const rect = event.currentTarget.getBoundingClientRect(), x = (event.clientX - rect.left) / rect.width * 2 - 1, y = (event.clientY - rect.top) / rect.height * 2 - 1
    update([(Math.atan2(y, x) * 180 / Math.PI + 360) % 360, Math.min(1, Math.hypot(x, y)), hsv[2]])
  }
  return <div className="qyt-atmosphere-color" data-disabled={disabled || undefined}>
    <div className="qyt-color-wheel" role="slider" tabIndex={disabled ? -1 : 0} aria-label={t('qThemeColorWheel')} aria-disabled={disabled} aria-valuemin={0} aria-valuemax={360} aria-valuenow={Math.round(hsv[0])} aria-valuetext={value} aria-describedby={`${id}-hint`}
      style={{ '--wheel-shade': 1 - hsv[2] } as React.CSSProperties}
      onPointerDown={event => { if (disabled) return; event.currentTarget.setPointerCapture(event.pointerId); pick(event) }}
      onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) pick(event) }}
      onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }}
      onKeyDown={event => {
        if (disabled) return
        const step = event.shiftKey ? 10 : 2
        if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
          event.preventDefault()
          update([(hsv[0] + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0) + 360) % 360,
            event.key === 'Home' ? 0 : event.key === 'End' ? 1 : Math.max(0, Math.min(1, hsv[1] + (event.key === 'ArrowUp' ? .02 : event.key === 'ArrowDown' ? -.02 : 0))), hsv[2]])
        }
      }}>
      <span className="qyt-color-thumb" style={{ left: `${50 + Math.cos(hsv[0] * Math.PI / 180) * hsv[1] * 48}%`, top: `${50 + Math.sin(hsv[0] * Math.PI / 180) * hsv[1] * 48}%`, background: value }}/>
    </div>
    <div className="qyt-color-controls">
      <div className="qyt-color-heading"><strong>{t('qThemeAtmosphereColor')}</strong><button type="button" disabled={disabled} aria-pressed={automatic} onClick={onReset}>{t('qThemeAutoColor')}</button></div>
      <label className="qyt-color-value"><span aria-hidden="true" style={{ background: value }}/><input aria-label={t('qThemeColorHex')} disabled={disabled} value={hex ?? value} maxLength={7} spellCheck={false} onChange={event => {
        setHex(event.target.value)
        if (/^#[\da-f]{6}$/i.test(event.target.value)) { setHex(null); onChange(event.target.value.toLowerCase()) }
      }} onBlur={() => setHex(null)}/></label>
      <label className="qyt-editor-range"><span>{t('qThemeBrightness')}</span><input type="range" min={0} max={100} disabled={disabled} value={Math.round(hsv[2] * 100)} onChange={event => update([hsv[0], hsv[1], Number(event.target.value) / 100])}/><output>{Math.round(hsv[2] * 100)}%</output></label>
      <div className="qyt-color-swatches">{SWATCHES.map(color => <button type="button" key={color} disabled={disabled} aria-label={`${t('qThemeAtmosphereColor')} ${color}`} aria-pressed={!automatic && value.toLowerCase() === color} style={{ background: color }} onClick={() => onChange(color)}/>)}</div>
      <small id={`${id}-hint`}>{t('qThemeColorWheelHint')}</small>
    </div>
  </div>
}
