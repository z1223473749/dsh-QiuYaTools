import React, { useEffect, useId, useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { CustomTheme } from '../custom-themes.ts'
import { maskSignature, MOTION_KINDS, type MotionPlan, type MotionPoint, type MotionRegion, type MotionStroke } from '../smart-motion.ts'
import { analyzeSmartTheme, reviewSmartTheme, loadMotionAssets, persistMotionAssets, discardMotionAssets, smartThemeRequest, type SmartModelRoute } from './smart-theme-api.ts'
import { alignSegmentedMotion, releaseMotionSegmentation } from './smart-segmentation.ts'
import { prepareMotionAssets, prepareMotionReview } from './smart-theme-processing.ts'
import type { LocaleKey } from './locales.ts'
const kindLabels: Record<MotionRegion['kind'], LocaleKey> = { sway: 'qThemeAiSway', wave: 'qThemeAiWave', drift: 'qThemeAiDrift', ripple: 'qThemeAiRipple', float: 'qThemeAiFloat', pulse: 'qThemeAiPulse' }
type RegionTool = MotionStroke['mode'] | 'anchor' | 'tip'
const COLORS = ['#739de6', '#e39aa6', '#72baaa', '#b49cdd', '#e5b96e', '#86b8db', '#dca9d6', '#9fbe83']
export function useSmartThemeEditor(ctx: Context, draft: CustomTheme, workingImage: string, disabled: boolean, t: (key: LocaleKey) => string, change: (value: CustomTheme['smartMotion']) => void) {
  const objectListId = useId()
  const overviewCache = useRef<{ source: string; prompt: string; plan: MotionPlan } | null>(null)
  const leaseId = useRef(crypto.randomUUID()), draftAssets = useRef(new Set<string>())
  const [objectsExpanded, setObjectsExpanded] = useState(false)
  const initial = draft.smartMotion
  const [analysisExpanded, setAnalysisExpanded] = useState(!initial)
  const [plan, setPlan] = useState<MotionPlan | null>(initial ?? null), [strokes, setStrokes] = useState<MotionStroke[]>(initial?.strokes ?? [])
  const [models, setModels] = useState<SmartModelRoute[]>([]), [modelLoading, setModelLoading] = useState(true), [prompt, setPrompt] = useState('')
  const [reviewing, setReviewing] = useState(false)
  const [analyzing, setAnalyzing] = useState(false), [building, setBuilding] = useState(false), [error, setError] = useState(''), [selected, setSelected] = useState(initial?.regions[0]?.id ?? '')
  const [built, setBuilt] = useState(initial ? maskSignature(initial, initial.strokes) : '')
  const [tool, setTool] = useState<RegionTool>('paint'), [radius, setRadius] = useState(.018), [editing, setEditing] = useState(false)
  const source = useRef(workingImage), image = useRef(draft.image), callback = useRef(change), generation = useRef<AbortController | null>(null)
  callback.current = change
  const discard = async () => {
    generation.current?.abort()
    await Promise.all([...draftAssets.current].map(async assetId => { await discardMotionAssets(ctx, assetId, leaseId.current); draftAssets.current.delete(assetId) }))
    releaseMotionSegmentation(); overviewCache.current = null
  }
  useEffect(() => () => { void discard().catch(() => {}) }, [ctx])
  useEffect(() => {
    const controller = new AbortController()
    let refreshing = false
    const refresh = async () => {
      if (refreshing || controller.signal.aborted) return
      refreshing = true
      try {
        const value = await smartThemeRequest<SmartModelRoute[]>(ctx, 'models', {}, controller.signal)
        if (controller.signal.aborted) return
        setModels(Array.isArray(value) ? value.filter(r => r && typeof r.provider === 'string' && typeof r.model === 'string' && typeof r.name === 'string') : [])
      } catch { /* Retry discovery automatically; do not direct a signed-in user away. */ }
      finally { refreshing = false; if (!controller.signal.aborted) setModelLoading(false) }
    }
    void refresh()
    const timer = setInterval(() => { if (!document.hidden) void refresh() }, 15_000)
    const focus = () => { void refresh() }
    window.addEventListener('focus', focus)
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener('focus', focus); generation.current?.abort() }
  }, [ctx])
  useEffect(() => {
    const controller = new AbortController()
    source.current = workingImage
    if (image.current !== draft.image) {
      void discard().catch(() => {})
      generation.current?.abort(); setAnalyzing(false); image.current = draft.image
      setPlan(null); setStrokes([]); setBuilt(''); setSelected(''); setAnalysisExpanded(true); setObjectsExpanded(false); setEditing(false); setError('')
    } else if (draft.smartMotion) {
      void loadMotionAssets(ctx, draft.smartMotion.assetId, controller.signal).then(assets => { if (!controller.signal.aborted) source.current = assets.source }).catch(() => {})
    }
    return () => controller.abort()
  }, [draft.image, workingImage, ctx])
  const signature = plan ? maskSignature(plan, strokes) : ''
  const latest = useRef({ draft, plan, strokes }); latest.current = { draft, plan, strokes }
  useEffect(() => {
    if (!plan || !signature || signature === built) { setBuilding(false); return }
    const controller = new AbortController(); setBuilding(true); setError('')
    const timer = setTimeout(() => {
      void prepareMotionAssets(source.current, image.current, plan, strokes, controller.signal, ctx).then(result => {
        if (controller.signal.aborted) { void discardMotionAssets(ctx, result.assetId).catch(() => {}); return }
        draftAssets.current.add(result.assetId)
        const current = latest.current
        callback.current({ version: 1, ...result, regions: current.plan!.regions, protect: current.plan!.protect, strokes: current.strokes })
        for (const previous of draftAssets.current) if (previous !== result.assetId) void discardMotionAssets(ctx, previous, leaseId.current).then(() => draftAssets.current.delete(previous)).catch(() => {})
        setBuilt(signature)
      }).catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'generation-failed') }).finally(() => { if (!controller.signal.aborted) setBuilding(false) })
    }, 250)
    return () => { clearTimeout(timer); controller.abort() }
  }, [signature, built])
  function updateRegion(id: string, patch: Partial<MotionRegion>) {
    if (!plan) return
    const next = { ...plan, regions: plan.regions.map(r => r.id === id ? { ...r, ...patch } : r) }; setPlan(next)
    if (draft.smartMotion && signature === built && maskSignature(next, strokes) === built) callback.current({ ...draft.smartMotion, ...next, strokes })
  }
  async function generate() {
    if (disabled || !draft.image || !models.length || analyzing) return
    const controller = new AbortController(), requestId = crypto.randomUUID(); generation.current?.abort(); generation.current = controller
    const cancel = () => { for (const id of [requestId, ...Array.from({length:8},(_,i)=>requestId+'-review-'+i),...Array.from({length:8},(_,i)=>requestId+'-confirm-'+i)]) void smartThemeRequest(ctx, 'cancel', { requestId: id }).catch(() => {}) }
    controller.signal.addEventListener('abort', cancel, { once: true }); setAnalyzing(true); setError('')
    const originalImage = draft.image
    try {
      const cached = overviewCache.current
      const overview = cached?.source === source.current && cached.prompt === prompt ? cached.plan : await analyzeSmartTheme(ctx, { requestId, image: source.current, prompt }, controller.signal)
      overviewCache.current = { source: source.current, prompt, plan: overview }
      if (!overview.regions.length) { setError('no-regions'); return }
      setReviewing(true)
      const result: MotionPlan = { ...overview, regions: [] }
      // Keep each object's candidates large enough to judge skin and thin edges.
      // Combining eight grids into one image caused incorrect choices after
      // the provider resized the contact sheet.
      for (const [index, region] of overview.regions.entries()) {
        controller.signal.throwIfAborted()
        const objectPlan: MotionPlan = { ...overview, regions: [region] }
        const sheet = await prepareMotionReview(source.current, objectPlan, controller.signal, ctx)
        const reviewed = await reviewSmartTheme(ctx, { ...sheet, plan: objectPlan, prompt, requestId: requestId + '-review-' + index }, controller.signal)
        if (reviewed.regions.length) {
          const confirmation = await prepareMotionReview(source.current, reviewed, controller.signal, ctx, true)
          const confirmed = await reviewSmartTheme(ctx, { ...confirmation, plan: reviewed, prompt, requestId: requestId + '-confirm-' + index }, controller.signal)
          result.regions.push(...(await alignSegmentedMotion(ctx, source.current, confirmed, controller.signal)).regions)
        }
      }
      if (controller.signal.aborted || image.current !== originalImage) return
      if (!result.regions.length) { setError('no-regions'); return }
      setPlan(result); setStrokes([]); setSelected(result.regions[0].id); setAnalysisExpanded(false); setObjectsExpanded(false); setEditing(false); setBuilt('')
    } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'generation-failed') }
    finally { controller.signal.removeEventListener('abort', cancel); if (generation.current === controller) { generation.current = null; setAnalyzing(false); setReviewing(false) } }
  }
  const pending = analyzing || building || !!plan && signature !== built
  const active = plan?.regions.find(r => r.id === selected)
  const errorKey: LocaleKey = error === 'unconfigured' ? 'qThemeAiNoModel' : error === 'no-regions' ? 'qThemeAiNoRegions' : error === 'segmentation-unavailable' ? 'qThemeAiSegmentationFailed' : error === 'asset-quota' ? 'qThemeAiQuota' : 'qThemeAiError'
  const controls = <section className="qyt-ai-panel">
    <div className="qyt-ai-heading"><strong>{t('qThemeAiTitle')}</strong><span>DeepSeek</span></div>
    {plan ? <div className="qyt-ai-ready"><span className="qyt-ai-ready-dot"/><div><strong>{t('qThemeAiReady')}</strong><small>{t('qThemeAiLocalPlayback')}</small></div><button type="button" aria-expanded={analysisExpanded} onClick={() => setAnalysisExpanded(!analysisExpanded)}>{t('qThemeAiAnalysisOptions')}</button></div> : <p>{t('qThemeAiIntro')}</p>}
    <div className="qyt-ai-analysis-options" hidden={!!plan && !analysisExpanded}>
    <label className="qyt-editor-field"><span>{t('qThemeAiPrompt')}</span><textarea rows={2} maxLength={1000} value={prompt} placeholder={t('qThemeAiPromptHint')} disabled={disabled || analyzing} onChange={event => setPrompt(event.target.value)}/></label>
    <div className="qyt-ai-auto-model" role="status"><span>{t('qThemeAiAutoModel')}</span><strong>{models[0]?.name ?? t(modelLoading ? 'qThemeAiModelLoading' : 'qThemeAiNoModel')}</strong></div>
    <div className="qyt-ai-actions"><button type="button" className="qyt-ai-generate" disabled={disabled || !draft.image || !models.length || analyzing || building} onClick={() => { void generate() }}>{t(plan ? 'qThemeAiRegenerate' : 'qThemeAiGenerate')}</button>{analyzing && <button type="button" onClick={() => { generation.current?.abort(); setAnalyzing(false) }}>{t('qThemeCancel')}</button>}</div>
    <small>{t('qThemeAiUsage')}</small></div>
    {pending && <p className="qyt-ai-status" role="status">{t(analyzing ? reviewing ? 'qThemeAiReviewing' : 'qThemeAiAnalyzing' : 'qThemeAiBuilding')}</p>}
    {error && <p className="qyt-editor-error" role="alert">{t(errorKey)}</p>}
    {plan && <><div className="qyt-ai-region-heading"><strong>{t('qThemeAiObjects')} · {plan.regions.length}</strong><div className="qyt-ai-region-actions"><button type="button" disabled={disabled} aria-expanded={objectsExpanded} aria-controls={objectListId} onClick={() => setObjectsExpanded(!objectsExpanded)}>{t(objectsExpanded ? 'qThemeAiCollapseObjects' : 'qThemeAiExpandObjects')}<span aria-hidden="true">{objectsExpanded ? '⌃' : '⌄'}</span></button><button type="button" disabled={disabled} onClick={() => setEditing(!editing)}>{t(editing ? 'qThemeAiWatch' : 'qThemeAiEdit')}</button></div></div>
      <div className="qyt-ai-regions" id={objectListId}>{(objectsExpanded ? plan.regions : active ? [active] : []).map(region => <div key={region.id} className="qyt-ai-region" data-selected={region.id === selected || undefined}>
        <input type="checkbox" aria-label={`${region.label} ${t('qThemeAiEnabled')}`} checked={region.enabled} disabled={disabled} onChange={event => updateRegion(region.id, { enabled: event.target.checked })}/>
        <button type="button" aria-pressed={region.id === selected} onClick={() => { if (objectsExpanded) { setSelected(region.id); setObjectsExpanded(false) } else setObjectsExpanded(true) }}><i style={{ background: COLORS[plan.regions.findIndex(item => item.id === region.id)] }}/><span>{region.label}</span><small>{t(kindLabels[region.kind])}</small></button>
      </div>)}</div>
      {active && <div className="qyt-ai-tuning"><label className="qyt-editor-field">{t('qThemeAiAction')}<select value={active.kind} disabled={disabled} onChange={event => updateRegion(active.id, { kind: event.target.value as MotionRegion['kind'] })}>{MOTION_KINDS.map(kind => <option key={kind} value={kind}>{t(kindLabels[kind])}</option>)}</select></label>
        <label className="qyt-editor-range"><span>{t('qThemeAiAmplitude')}</span><input aria-label={t('qThemeAiAmplitude')} type="range" min={0} max={25} step={.5} value={active.amplitude * 1000} disabled={disabled} onChange={event => updateRegion(active.id, { amplitude: Number(event.target.value) / 1000 })}/><output>{(active.amplitude * 100).toFixed(2)}%</output></label>
        <label className="qyt-editor-range"><span>{t('qThemeSpeed')}</span><input aria-label={t('qThemeAiObjectSpeed')} type="range" min={.1} max={3} step={.05} value={active.speed} disabled={disabled} onChange={event => updateRegion(active.id, { speed: Number(event.target.value) })}/><output>{active.speed.toFixed(2)}×</output></label>
        <label className="qyt-editor-range"><span>{t('qThemeAiDirection')}</span><input type="range" min={-180} max={180} step={5} value={active.direction} disabled={disabled} onChange={event => updateRegion(active.id, { direction: Number(event.target.value) })}/><output>{active.direction}°</output></label>
      </div>}
      <button type="button" disabled={disabled || pending} onClick={() => { void discard().catch(() => {}); setPlan(null); setStrokes([]); setBuilt(''); setEditing(false); callback.current(undefined) }}>{t('qThemeAiRemove')}</button>
    </>}
  </section>
  const editor = plan && <div className="qyt-region-workspace"><div className="qyt-region-edit-status"><span>{t('qThemeAiEditingPaused')}</span><button type="button" onClick={() => setEditing(false)}>{t('qThemeAiPlayPreview')}</button></div><div className="qyt-region-toolbar">
    {(['paint', 'erase', 'protect', 'anchor', 'tip'] as const).map(mode => <button key={mode} type="button" disabled={disabled || analyzing} aria-pressed={tool === mode} onClick={() => setTool(mode)}>{t(mode === 'paint' ? 'qThemeAiPaint' : mode === 'erase' ? 'qThemeAiErase' : mode === 'protect' ? 'qThemeAiProtect' : mode === 'anchor' ? 'qThemeAiAnchor' : 'qThemeAiTip')}</button>)}
    <button type="button" disabled={disabled || !strokes.length || analyzing} onClick={() => setStrokes(current => current.slice(0, -1))}>{t('qThemeAiUndo')}</button>
    <label>{t('qThemeAiBrush')}<input type="range" min={.004} max={.06} step={.002} value={radius} onChange={e => setRadius(Number(e.target.value))}/></label>
  </div><RegionCanvas ctx={ctx} motion={draft.smartMotion} image={source.current} plan={plan} strokes={strokes} selected={selected} tool={tool} radius={radius} disabled={disabled || analyzing || strokes.length >= 128} onPoint={(key, point) => updateRegion(selected, { [key]: point })} onStroke={stroke => setStrokes(current => [...current, stroke])}/><small>{t('qThemeAiEditHint')}</small></div>
  return { controls, editor, editing, setEditing, pending, discard,
    persist: () => { if (!draft.smartMotion) return Promise.resolve(); draftAssets.current.add(draft.smartMotion.assetId); return persistMotionAssets(ctx, draft.smartMotion.assetId, leaseId.current) },
    releaseFailedSave: () => draft.smartMotion && draftAssets.current.has(draft.smartMotion.assetId) ? discardMotionAssets(ctx, draft.smartMotion.assetId, leaseId.current, false) : Promise.resolve(),
  }
}
function RegionCanvas({ ctx, motion, image, plan, strokes, selected, tool, radius, disabled, onPoint, onStroke }: {
  ctx: Context; motion: CustomTheme['smartMotion']; image: string; plan: MotionPlan; strokes: MotionStroke[]; selected: string; tool: RegionTool; radius: number; disabled: boolean; onPoint(key: 'anchor' | 'tip', point: MotionPoint): void; onStroke(stroke: MotionStroke): void
}) {
  const raster = useRef<{ id: string; selected: string; canvas: HTMLCanvasElement } | null>(null)
  const ref = useRef<HTMLCanvasElement>(null), bitmap = useRef<HTMLImageElement | null>(null), drawing = useRef<MotionStroke | null>(null), pointer = useRef<number | null>(null)
  const render = () => {
    const canvas = ref.current, img = bitmap.current, context = canvas?.getContext('2d'); if (!canvas || !img || !context) return
    const ctx: CanvasRenderingContext2D = context
    if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) { canvas.width = img.naturalWidth; canvas.height = img.naturalHeight }
    ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(img, 0, 0)
    function polygon(points: MotionPoint[], color: string, fill: boolean) {
      ctx.beginPath(); points.forEach(([x, y], i) => i ? ctx.lineTo(x * canvas!.width, y * canvas!.height) : ctx.moveTo(x * canvas!.width, y * canvas!.height)); ctx.closePath()
      if (fill) { ctx.fillStyle = color + '33'; ctx.fill() } ctx.strokeStyle = color; ctx.lineWidth = canvas!.width / 500; ctx.stroke()
    }
    for (const [i, r] of plan.regions.entries()) {
      if (r.id !== selected) continue
      ctx.globalAlpha = 1; if (raster.current?.id === motion?.assetId && raster.current?.selected === selected) ctx.drawImage(raster.current.canvas, 0, 0, canvas.width, canvas.height); else polygon(r.polygon, COLORS[i], true)
      if (r.id === selected) {
        ctx.beginPath(); ctx.moveTo(r.anchor[0] * canvas.width, r.anchor[1] * canvas.height); ctx.lineTo(r.tip[0] * canvas.width, r.tip[1] * canvas.height); ctx.setLineDash([8, 6]); ctx.stroke(); ctx.setLineDash([])
        ctx.beginPath(); ctx.arc(r.anchor[0] * canvas.width, r.anchor[1] * canvas.height, canvas.width / 160, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.stroke()
        ctx.beginPath(); ctx.arc(r.tip[0] * canvas.width, r.tip[1] * canvas.height, canvas.width / 180, 0, Math.PI * 2); ctx.fillStyle = COLORS[i]; ctx.fill(); ctx.stroke()
      }
    }
    const active = plan.regions.find(r => r.id === selected)
    ctx.globalAlpha = .8; for (const p of plan.protect) {
      if (active && p.some(([x,y]) => x >= Math.min(...active.polygon.map(p=>p[0])) && x <= Math.max(...active.polygon.map(p=>p[0])) && y >= Math.min(...active.polygon.map(p=>p[1])) && y <= Math.max(...active.polygon.map(p=>p[1])))) polygon(p, '#e57c83', true)
    }
    for (const stroke of [...strokes.filter(s => s.regionId === selected), ...(drawing.current ? [drawing.current] : [])]) {
      ctx.strokeStyle = stroke.mode === 'protect' ? '#e57c83' : stroke.mode === 'erase' ? '#ffffff' : COLORS[Math.max(0, plan.regions.findIndex(r => r.id === stroke.regionId))]
      ctx.globalAlpha = .6; ctx.lineWidth = stroke.radius * canvas.width * 2; ctx.lineCap = ctx.lineJoin = 'round'
      ctx.beginPath(); stroke.points.forEach(([x, y], i) => i ? ctx.lineTo(x * canvas.width, y * canvas.height) : ctx.moveTo(x * canvas.width, y * canvas.height)); ctx.stroke()
    }
    ctx.globalAlpha = 1
  }
  useEffect(() => { let alive = true; const img = new Image(); img.onload = () => { if (alive) { bitmap.current = img; render() } }; img.src = image; return () => { alive = false; img.onload = null; bitmap.current = null } }, [image])
  useEffect(render, [plan, strokes, selected])
  useEffect(() => {
    const controller = new AbortController(); raster.current = null
    if (motion) void loadMotionAssets(ctx, motion.assetId, controller.signal).then(async assets => {
      const index = motion.regions.findIndex(r => r.id === selected); if (index < 0) return
      const bitmap = new Image(); bitmap.src = assets.masks[Math.floor(index / 3)]; await bitmap.decode()
      if (controller.signal.aborted) return
      const canvas = document.createElement('canvas'); canvas.width = bitmap.naturalWidth; canvas.height = bitmap.naturalHeight
      const c = canvas.getContext('2d')!; c.drawImage(bitmap, 0, 0); const rgba = c.getImageData(0, 0, canvas.width, canvas.height), color = COLORS[index]
      for (let p = 0; p < rgba.data.length; p += 4) { const alpha = rgba.data[p + index % 3]; rgba.data[p] = parseInt(color.slice(1,3),16); rgba.data[p+1] = parseInt(color.slice(3,5),16); rgba.data[p+2] = parseInt(color.slice(5,7),16); rgba.data[p+3] = alpha * .48 }
      c.putImageData(rgba, 0, 0); raster.current = { id: motion.assetId, selected, canvas }; render()
    }).catch(() => {})
    return () => controller.abort()
  }, [ctx, motion?.assetId, selected])
  const point = (event: React.PointerEvent<HTMLCanvasElement>): MotionPoint => { const rect = event.currentTarget.getBoundingClientRect(); return [Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))] }
  return <canvas ref={ref} className="qyt-region-canvas" aria-label="AI motion region editor" onPointerDown={event => {
    if (disabled || !selected) return
    if (tool === 'anchor' || tool === 'tip') { onPoint(tool, point(event)); return }
    event.currentTarget.setPointerCapture(event.pointerId); pointer.current = event.pointerId; drawing.current = { regionId: selected, mode: tool, radius, points: [point(event)] }; render()
  }} onPointerMove={event => { if (!drawing.current || pointer.current !== event.pointerId || drawing.current.points.length >= 128) return; drawing.current.points.push(point(event)); render() }} onPointerUp={event => {
    if (!drawing.current || pointer.current !== event.pointerId) return
    const stroke = drawing.current; drawing.current = null; pointer.current = null; onStroke(stroke)
  }} onPointerCancel={() => { drawing.current = null; pointer.current = null; render() }}/>
}
