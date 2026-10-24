import { useRef, useState } from 'react';
import type { AnnotationAnchor } from '../annotations/contract.ts';
import { assertStyleCurrent, changeStyle, createStyleDraft, setStyleSample, styleFeedback } from './contract.ts';
import type { StyleBaseline, StyleChanges, StyleFeedback } from './contract.ts';
import { stylePreview } from './preview.ts';
export interface StyleFeedbackEditorProps {
    readonly baseline: StyleBaseline;
    readonly currentAnchor?: AnnotationAnchor;
    readonly currentCaptureId?: string;
    readonly currentElementId?: string;
    /** Synchronous addition to the existing local H4 draft only. It is never a model or device call. */
    readonly onAdd: (feedback: StyleFeedback) => void;
    readonly onClose: () => void;
}
const fields = [
    ['fontSize', '字号', 'font-size', 8, 72, 1], ['fontWeight', '字重', 'font-weight', 100, 900, 100],
    ['lineHeight', '行距（倍字号）', 'line-height', .8, 2.4, .1], ['letterSpacing', '字距（px）', 'letter-spacing', -2, 8, .1],
    ['paddingTop', '上内边距（px）', 'padding-top', 0, 64, 1], ['paddingRight', '右内边距（px）', 'padding-right', 0, 64, 1],
    ['paddingBottom', '下内边距（px）', 'padding-bottom', 0, 64, 1], ['paddingLeft', '左内边距（px）', 'padding-left', 0, 64, 1],
] as const;
const hex = (value: string, fallback: string) => { if (/^#[a-f\d]{6}$/iu.test(value))
    return value; const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/u.exec(value); return m && m.slice(1, 4).every(v => Number(v) <= 255) ? '#' + m.slice(1, 4).map(v => Number(v).toString(16).padStart(2, '0')).join('') : fallback; };
export function StyleFeedbackEditor({ baseline, currentAnchor, currentCaptureId, currentElementId, onAdd, onClose }: StyleFeedbackEditorProps) {
    const [draft, setDraft] = useState(() => createStyleDraft(baseline)), [error, setError] = useState(''), [status, setStatus] = useState(''), issued = useRef(false);
    let stale = false;
    try {
        assertStyleCurrent(draft.baseline, currentAnchor, currentCaptureId, currentElementId);
        if (draft.baseline.baselineId !== baseline.baselineId)
            stale = true;
    }
    catch {
        stale = true;
    }
    const update = (key: keyof StyleChanges, value: string | number | undefined) => { if (stale || issued.current)
        return; try {
        const next = { ...draft.changes };
        if (value === undefined)
            delete next[key];
        else
            Object.assign(next, { [key]: value });
        setDraft(changeStyle(draft, next));
        setError('');
    }
    catch (e) {
        setError(e instanceof Error ? e.message : '样式值无效。');
    } };
    const add = () => { if (stale || issued.current)
        return; try {
        const feedback = styleFeedback(draft, currentAnchor, currentCaptureId, currentElementId);
        issued.current = true;
        onAdd(feedback);
        setStatus('样式反馈已加入本次批注，尚未发送到聊天。');
    }
    catch (e) {
        if (issued.current)
            setStatus('添加结果尚未确认，请查看本次批注草稿，勿重复添加。');
        else
            setError(e instanceof Error ? e.message : '样式反馈暂时不可用。');
    } };
    if (stale)
        return <section className="qyt-style-feedback" aria-label="临时样式反馈"><style>{STYLE_FEEDBACK_CSS}</style><header><strong>临时样式反馈</strong><button type="button" onClick={onClose}>关闭</button></header><p role="alert">画面或元素已变化，请关闭后重新选取。</p></section>;
    return <section className="qyt-style-feedback" aria-label="临时样式反馈" onPointerDown={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}><style>{STYLE_FEEDBACK_CSS}</style>
    <header><div><h4>临时样式反馈</h4><p>{draft.baseline.selection.role} · {draft.baseline.selection.name || '已选元素'}</p></div><button type="button" onClick={onClose}>{issued.current ? '关闭' : '取消'}</button></header>
    <p className="qyt-style-caption">在本地文字样例中比较效果。目标页面和源码尚未修改，确认后仅将建议加入批注草稿。</p>
    <div className="qyt-style-sample-box"><div aria-label="本地文字样例" data-local-preview-only="true" style={stylePreview(draft)}>{draft.sample || '文字样例'}</div></div>
    <label className="qyt-style-label">样例文字<textarea aria-label="样例文字" maxLength={256} value={draft.sample} disabled={issued.current} onChange={e => { try {
        setDraft(setStyleSample(draft, e.target.value));
    }
    catch {
        setError('样例文字最多 256 字。');
    } }}/></label>
    <div className="qyt-style-fields"><label>字体<select aria-label="样例字体" value={draft.changes.fontFamily ?? ''} disabled={issued.current} onChange={e => update('fontFamily', e.target.value || undefined)}><option value="">保持原值</option><option value="system">系统字体</option><option value="serif">衬线字体</option><option value="monospace">等宽字体</option></select><small>源网页：{draft.baseline.values['font-family']}；未更改时样例使用系统字体。</small></label>
    {fields.map(([key, label, css, min, max, step]) => <label key={key}>{label}<input aria-label={label} type="number" min={min} max={max} step={step} placeholder="保持原值" value={draft.changes[key] ?? ''} disabled={issued.current} onChange={e => update(key, e.target.value === '' ? undefined : e.target.valueAsNumber)}/><small>原值：{draft.baseline.values[css]}</small></label>)}
    {([['color', '文字颜色', 'color', '#000000'], ['backgroundColor', '背景颜色', 'background-color', '#ffffff']] as const).map(([key, label, css, fallback]) => <label key={key}>{label}<input aria-label={label} type="color" value={draft.changes[key] && draft.changes[key] !== 'transparent' ? draft.changes[key] : hex(draft.baseline.values[css], fallback)} disabled={issued.current} onChange={e => update(key, e.target.value)}/><small>原值：{draft.baseline.values[css]}</small></label>)}
    <button type="button" disabled={issued.current} onClick={() => update('backgroundColor', 'transparent')}>使用透明背景</button></div>
    {error && <p role="alert">{error}</p>}{status && <p role="status">{status}</p>}
    <footer><button type="button" disabled={issued.current || !Object.keys(draft.changes).length} onClick={() => { setDraft(changeStyle(draft, {})); setError(''); }}>恢复原值</button><button type="button" className="qyt-style-primary" disabled={issued.current || !Object.keys(draft.changes).length} onClick={add}>加入本次批注</button></footer>
  </section>;
}
export const STYLE_FEEDBACK_CSS = `.qyt-style-feedback{display:flex;flex-direction:column;gap:12px;padding:16px;border:1px solid var(--dsw-alias-border-l1,#dfe7e6);border-radius:12px;background:var(--dsw-alias-surface-l1,#fff);color:var(--dsw-alias-label-primary,#263b3f);font:inherit;min-width:0}.qyt-style-feedback header,.qyt-style-feedback footer{display:flex;align-items:center;justify-content:space-between;gap:10px}.qyt-style-feedback h4,.qyt-style-feedback p{margin:0}.qyt-style-feedback h4{font-size:14px}.qyt-style-feedback header p,.qyt-style-caption,.qyt-style-feedback small{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,#64767a)}.qyt-style-sample-box{max-height:220px;overflow:auto;padding:6px;border:1px solid var(--dsw-alias-border-l1,#dfe7e6);border-radius:8px;background:var(--dsw-static-neutral-50,#f3f6f5)}.qyt-style-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.qyt-style-fields label,.qyt-style-label{display:flex;flex-direction:column;gap:5px;min-width:0;font-size:12px}.qyt-style-feedback input,.qyt-style-feedback textarea,.qyt-style-feedback select,.qyt-style-feedback button{font:inherit;color:inherit;background:var(--dsw-alias-surface-l1,#fff);border:1px solid var(--dsw-alias-border-l1,#dfe7e6);border-radius:7px;padding:7px 9px;min-width:0}.qyt-style-feedback textarea{min-height:56px;resize:vertical}.qyt-style-feedback input[type=color]{width:100%;height:34px;padding:3px}.qyt-style-feedback button{cursor:pointer}.qyt-style-feedback button:disabled{opacity:.5;cursor:default}.qyt-style-feedback button.qyt-style-primary{color:#fff;background:#147e91;border-color:#147e91}.qyt-style-feedback [role=alert]{color:var(--dsw-alias-state-error-primary,#a8493f)}.qyt-style-feedback small{overflow-wrap:anywhere}`;
