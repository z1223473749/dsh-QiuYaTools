import React, { useEffect, useRef, useState } from 'react';
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives';
import type { PropsStore } from '@deepseek-ai/dsh-client-store';
import type { EvidenceRef, RunView } from './contract.ts';
import { RUN_STATES } from './contract.ts';
import { RUN_STATE_LABELS, summaryFromView } from './model.ts';
import type { RunHistoryRow, RunSummary } from './model.ts';
import type { RunReadAPI } from './client-api.ts';
import { RunReadLifetime } from './client-api.ts';
import type { createRunUIStore } from './ui-store.ts';
export type RunUIProps = PropsStore<ReturnType<typeof createRunUIStore>>;
const codeLabels: Record<string, string> = { VERIFIED: '独立验收已确认', BUSINESS_MISMATCH: '实际结果与预期不符', VERIFIER_UNAVAILABLE: '尚无独立验收依据', VERIFIER_FAILED: '验收结果未能确认', EVIDENCE_UNAVAILABLE: '证据暂不可用', MISSING_EVIDENCE: '缺少检查点证据', ACTION_UNKNOWN: '操作结果待确认', NOT_EXECUTED: '尚未执行', INTERRUPTED: '运行已中断', ENVIRONMENT_UNAVAILABLE: '操作环境暂不可用', BUDGET_EXHAUSTED: '已达到本次任务限制' };
export function RunGlyph() { return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true"><path d="M5 4h14a2 2 0 0 1 2 2v10H3V6a2 2 0 0 1 2-2Zm3 16h8m-4-4v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><path d="m8 10 2.5 2.5L16 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
export function EvidenceThumbnail({ refValue, chatSessionId, api, onUnavailable }: {
    refValue: EvidenceRef;
    chatSessionId: string;
    api: RunReadAPI;
    onUnavailable?(): void;
}) {
    const [url, setURL] = useState(''), [failed, setFailed] = useState(false), [expanded, setExpanded] = useState(false);
    const close = () => setExpanded(false);
    useEffect(() => {
        const controller = new AbortController();
        let active = true, objectURL: string | undefined;
        setURL('');
        setFailed(false);
        setExpanded(false);
        void (async () => { const data = await api.evidence(chatSessionId, refValue.runId, refValue.evidenceId, controller.signal); if (data.sha256 !== refValue.sha256 || data.bytes !== refValue.bytes || data.mediaType !== refValue.mediaType || data.width !== refValue.width || data.height !== refValue.height)
            throw Error('Evidence binding changed'); const decoded = atob(data.base64), bytes = new Uint8Array(decoded.length); for (let i = 0; i < decoded.length; i++)
            bytes[i] = decoded.charCodeAt(i); if (bytes.length !== refValue.bytes)
            throw Error('Evidence length mismatch'); const hash = await crypto.subtle.digest('SHA-256', bytes), actual = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join(''); if (actual !== refValue.sha256)
            throw Error('Evidence checksum mismatch'); controller.signal.throwIfAborted(); if (!active)
            return; objectURL = URL.createObjectURL(new Blob([bytes], { type: data.mediaType })); setURL(objectURL); })().catch(() => { if (active && !controller.signal.aborted) {
            setFailed(true);
            onUnavailable?.();
        } });
        return () => { active = false; controller.abort(); if (objectURL)
            URL.revokeObjectURL(objectURL); };
    }, [api, chatSessionId, refValue.runId, refValue.evidenceId, refValue.sha256, refValue.bytes, refValue.mediaType, refValue.width, refValue.height]);
    return <div className="qyt-run-evidence">{failed ? <span role="status">证据暂不可用</span> : url ? <button type="button" aria-label="查看检查点截图" onClick={() => setExpanded(true)}><img src={url} alt="任务检查点截图" onLoad={event => { if (event.currentTarget.naturalWidth !== refValue.width || event.currentTarget.naturalHeight !== refValue.height) {
        setFailed(true);
        onUnavailable?.();
    } }} onError={() => { setFailed(true); onUnavailable?.(); }}/></button> : <span>正在核验证据…</span>}{expanded && url && !failed && <Modal open headless title="检查点截图" onClose={close} className="qyt-run qyt-run-image-dialog"><button type="button" data-modal-autofocus onClick={close}>关闭截图</button><img src={url} alt="检查点原图"/></Modal>}</div>;
}
export function RunResultCard({ summary, sessionId, api, onOpen }: {
    summary: RunSummary;
    sessionId: string;
    api: RunReadAPI;
    onOpen(runId?: string): void;
}) {
    const [view, setView] = useState<RunView>(), [error, setError] = useState(false), [imageMissing, setImageMissing] = useState(false), lifetime = useRef<RunReadLifetime>();
    useEffect(() => { const owner = new RunReadLifetime(); lifetime.current = owner; setView(undefined); setError(false); setImageMissing(false); if (summary.chatSessionId === sessionId)
        void owner.read(signal => api.get(sessionId, summary.runId, signal), setView).catch(() => setError(true)); return () => owner.dispose(); }, [api, sessionId, summary.runId, summary.chatSessionId, summary.revision]);
    if (summary.chatSessionId !== sessionId)
        return null;
    const fresh = view && view.record.runId === summary.runId && view.record.binding.chatSessionId === sessionId && view.record.revision >= summary.revision ? view : undefined;
    const current = fresh ? summaryFromView(fresh) : summary, verified = !!fresh && !imageMissing && !error, state = verified ? current.state : 'inconclusive', label = error ? '记录暂不可用' : imageMissing ? '证据暂不可用' : !fresh ? '正在核对记录…' : RUN_STATE_LABELS[state];
    return <section className="qyt-run qyt-run-card" aria-label="电脑任务验收结果" data-run-id={summary.runId}><header><span className="qyt-run-icon"><RunGlyph /></span><div className="qyt-run-heading"><strong>{current.title}</strong><span className="qyt-run-muted">{current.requiredPassed}/{current.requiredTotal} 项必需检查 · {current.evidenceCount} 份证据</span></div><span className="qyt-run-status" data-state={state}>{label}</span></header>{fresh?.recovery === 'restart-interrupted' && <p className="qyt-run-note">上次运行已中断，记录仅供查看。</p>}{error && <p className="qyt-run-note" role="status">暂时无法核对记录，请稍后查看详情。</p>}{fresh && fresh.record.evidence.length > 0 && <div className="qyt-run-thumbnails">{fresh.record.evidence.slice(0, 3).map(e => <EvidenceThumbnail key={e.evidenceId} refValue={e} chatSessionId={sessionId} api={api} onUnavailable={() => setImageMissing(true)}/>)}</div>}<footer><button type="button" className="qyt-run-link" onClick={() => onOpen(summary.runId)}>查看详情</button><button type="button" className="qyt-run-link" onClick={() => onOpen()}>任务历史</button>{current.endedAt !== null && <span className="qyt-run-muted">用时 {Math.max(0, Math.round((current.endedAt - current.createdAt) / 1000))} 秒</span>}</footer></section>;
}
export function RunHistory({ rows, onOpen, useStore, actions }: RunUIProps & {
    rows: RunHistoryRow[];
    onOpen(runId: string): void;
}) { const filter = useStore(s => s.filter), shown = filter === 'all' ? rows : rows.filter(r => r.state === filter); return <section className="qyt-run qyt-run-history"><header><div><h3>任务历史</h3><p className="qyt-run-muted">查看本会话的检查结果和证据。</p></div><label>筛选<select value={filter} onChange={e => { const value = e.target.value; actions.setFilter(value === 'all' ? 'all' : RUN_STATES.find(s => s === value) ?? 'all'); }}><option value="all">全部状态</option>{RUN_STATES.map(s => <option key={s} value={s}>{RUN_STATE_LABELS[s]}</option>)}</select></label></header>{shown.length === 0 ? <p className="qyt-run-empty">还没有符合条件的任务记录。</p> : <ol className="qyt-run-list">{shown.map(row => <li key={row.runId}><button type="button" onClick={() => onOpen(row.runId)}><span>{row.title}</span><span className="qyt-run-muted">{RUN_STATE_LABELS[row.state]}</span><span aria-hidden="true">›</span></button></li>)}</ol>}<p className="qyt-run-note">历史记录仅供查看，打开记录不会恢复电脑操作。</p></section>; }
export function RunDetails({ view, sessionId, api, onHistory, useStore, actions }: RunUIProps & {
    view: RunView;
    sessionId: string;
    api: RunReadAPI;
    onHistory(): void;
}) {
    const expanded = useStore(s => s.expanded), [imageMissing, setImageMissing] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(false), lifetime = useRef<RunReadLifetime>();
    useEffect(() => { const owner = new RunReadLifetime(); lifetime.current = owner; setBusy(false); setError(''); setImageMissing(false); return () => owner.dispose(); }, [view.record.runId, sessionId]);
    const r = view.record, summary = summaryFromView(view), displayState = imageMissing ? 'inconclusive' : view.state;
    const download = () => { if (busy)
        return; setBusy(true); setError(''); void lifetime.current?.read(signal => api.export(sessionId, r.runId, signal), report => { const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = 'qiuya-run-' + r.runId + '.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 0); setBusy(false); }).catch(() => { setBusy(false); setError('报告暂时无法导出，请稍后重试。'); }); };
    return <section className="qyt-run qyt-run-details"><header><button className="qyt-run-link" type="button" onClick={onHistory}>‹ 任务历史</button><button type="button" onClick={download} disabled={busy}>{busy ? '正在导出…' : '导出报告'}</button></header><h3>{r.title}</h3><p><span className="qyt-run-status" data-state={displayState}>{imageMissing ? '证据暂不可用' : RUN_STATE_LABELS[displayState]}</span><span className="qyt-run-muted">　{summary.requiredPassed}/{summary.requiredTotal} 项必需检查 · 仅供查看</span></p>{view.recovery !== 'none' && <p className="qyt-run-note">{view.recovery === 'evidence-unavailable' ? '部分证据暂不可用，结果待确认。' : view.recovery === 'restart-interrupted' ? '上次运行已中断。可在会话中发起新任务。' : '这是一份历史记录。'}</p>}{error && <p role="alert">{error}</p>}<div className="qyt-run-checks">{r.checks.map(check => <details key={check.checkId} open={expanded[r.runId + ':' + check.checkId] ?? false} onToggle={event => actions.expand(r.runId + ':' + check.checkId, event.currentTarget.open)}><summary><span>{check.title}</span><span className="qyt-run-muted">{check.required ? '必需' : '可选'}</span></summary><p className="qyt-run-muted">预期：{check.expected}</p>{r.attempts.filter(a => a.checkId === check.checkId).length === 0 ? <p className="qyt-run-note">尚未执行此项检查。</p> : r.attempts.filter(a => a.checkId === check.checkId).map((attempt, index) => <div className="qyt-run-attempt" key={attempt.attemptId}><strong>第 {index + 1} 次检查 · {attempt.verdict === null ? '尚未完成' : RUN_STATE_LABELS[attempt.verdict]}</strong><p className="qyt-run-muted">{attempt.verificationCode ? codeLabels[attempt.verificationCode] ?? '检查结果待确认' : '正在收集实际证据'}</p>{attempt.assessment && <p className="qyt-run-note">模型建议已记录；实际结论以独立验收为准。</p>}<div className="qyt-run-thumbnails">{attempt.evidenceIds.map(id => r.evidence.find(e => e.evidenceId === id)).filter((e): e is EvidenceRef => !!e).map(e => <EvidenceThumbnail key={e.evidenceId} refValue={e} chatSessionId={sessionId} api={api} onUnavailable={() => setImageMissing(true)}/>)}</div></div>)}</details>)}</div></section>;
}
