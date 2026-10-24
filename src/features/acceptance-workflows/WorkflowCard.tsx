import React, { useEffect, useRef, useState } from 'react';
import type { WorkflowView, WorkflowPlan, WorkflowRule } from './contract.ts';
import type { WorkflowSummary } from './model.ts';
import type { WorkflowAPI } from './client-api.ts';
import { RunGlyph } from '../acceptance-runs/RunGlyph.tsx';
import { RUN_STATE_LABELS, summaryFromView } from '../acceptance-runs/model.ts';
const phases: Record<string, string> = { draft: '验收清单', discarded: '清单已放弃', running: '正在验收', awaitingRepair: '等待修复授权', cancelRequested: '正在停止', closed: '验收已结束', interrupted: '运行已中断' };
/** The card edits facts/requirements only. Owner choices never emit an execution or verdict directly. */
export function WorkflowCard({ summary, sessionId, api, onOpenRun, onTemplates }: {
    summary: WorkflowSummary;
    sessionId: string;
    api: WorkflowAPI;
    onOpenRun(id: string): void;
    onTemplates?(id: string): void;
}) {
    const [view, setView] = useState<WorkflowView>(), [error, setError] = useState(''), [busy, setBusy] = useState(false), [draft, setDraft] = useState<WorkflowPlan>(), [editRevision, setEditRevision] = useState(0), [refresh, setRefresh] = useState(0), [unknown, setUnknown] = useState(false);
    const lifetime = useRef<AbortController>(), pending = useRef(false), mounted = useRef(false);
    useEffect(() => {
        const owner = new AbortController();
        lifetime.current = owner;
        mounted.current = true;
        pending.current = false;
        setView(undefined);
        setError('');
        setDraft(undefined);
        setBusy(false);
        setUnknown(false);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const read = async () => {
            let shouldPoll = false;
            if (summary.chatSessionId !== sessionId)
                return;
            try {
                const value = await api.get(sessionId, summary.workflowId, owner.signal);
                if (owner.signal.aborted)
                    return;
                setView(current => !current || value.record.revision >= current.record.revision ? value : current);
                shouldPoll = !value.readOnly && ['draft', 'running', 'awaitingRepair'].includes(value.record.phase);
            }
            catch {
                if (!owner.signal.aborted)
                    setError('暂时无法核对最新任务，请刷新后继续。');
            }
            finally {
                if (!owner.signal.aborted && shouldPoll)
                    timer = setTimeout(() => { void read(); }, 800);
            }
        };
        void read();
        return () => {
            mounted.current = false;
            owner.abort();
            if (timer)
                clearTimeout(timer);
        };
    }, [api, sessionId, summary.chatSessionId, summary.workflowId, summary.revision, refresh]);
    if (summary.chatSessionId !== sessionId)
        return null;
    const fresh = view && view.record.workflowId === summary.workflowId && view.record.chatSessionId === sessionId && view.record.revision >= summary.revision ? view : undefined, record = fresh?.record, readonly = !fresh || fresh.readOnly || !!error || unknown, editable = !readonly && record?.phase === 'draft', run = fresh?.run, runSummary = run ? summaryFromView(run) : undefined;
    const mutate = (work: (signal: AbortSignal) => Promise<WorkflowView>) => {
        const owner = lifetime.current;
        if (!owner || owner.signal.aborted || pending.current || readonly)
            return;
        pending.current = true;
        setBusy(true);
        setError('');
        void work(owner.signal).then(value => {
            if (owner.signal.aborted || !mounted.current)
                return;
            setView(current => !current || value.record.revision >= current.record.revision ? value : current);
            setDraft(undefined);
        }, () => {
            if (owner.signal.aborted || !mounted.current)
                return;
            setUnknown(true);
            setError('本次提交结果尚未确认。请刷新记录，不要重复提交。');
        }).finally(() => {
            if (owner.signal.aborted || !mounted.current)
                return;
            pending.current = false;
            setBusy(false);
        });
    };
    const update = (index: number, fields: Partial<WorkflowPlan['checks'][number]>) => setDraft(current => current ? { ...current, checks: current.checks.map((check, i) => i === index ? { ...check, ...fields } : check) } : current);
    const updateRule = (index: number, fields: Partial<WorkflowRule>) => {
        const check = draft?.checks[index];
        if (check)
            update(index, { rule: { ...check.rule, ...fields } as WorkflowRule });
    };
    const addCheck = () => setDraft(current => {
        if (!current || current.checks.length >= 32)
            return current;
        const checks = [...current.checks, { checkId: 'owner-' + crypto.randomUUID(), title: '新增检查', expected: '请填写预期结果', required: true, minimumEvidence: 1, rule: { kind: 'unavailable' as const, reason: '需要在会话中确认独立校验依据' } }];
        return { ...current, checks, budget: { ...current.budget, maxAttempts: Math.max(current.budget.maxAttempts, checks.length), maxEvidence: Math.max(current.budget.maxEvidence, checks.reduce((sum, c) => sum + c.minimumEvidence, 0)) } };
    });
    const editing = !!draft && editable && record.revision === editRevision;
    return <section className="qyt-run qyt-workflow" aria-label="自动验收清单" data-workflow-id={summary.workflowId}>
    <header><span className="qyt-run-icon"><RunGlyph /></span><div className="qyt-run-heading"><strong>{record?.plan.title ?? summary.title}</strong><span className="qyt-run-muted">{runSummary ? `${runSummary.requiredPassed}/${runSummary.requiredTotal} 项必需检查 · ${runSummary.attemptCount} 次检查` : '从当前会话自动使用已授权的应用与浏览器'}</span></div><span className="qyt-run-status" data-state={run?.state ?? 'running'}>{!fresh ? '正在核对记录…' : run ? RUN_STATE_LABELS[run.state] : phases[record!.phase]}</span></header>
    {error && <p role="alert" className="qyt-run-note">{error}</p>}
    {record?.cancel?.facts?.deviceReleased === true && record.cancel.quiescent !== true && <p className="qyt-run-note" role="status">本次任务的设备输入已停止，模型退场或消息队列仍待确认。</p>}{fresh?.recovery !== 'none' && fresh && <p className="qyt-run-note">{fresh.recovery === 'cancel-unconfirmed' ? '停止结果尚未确认，此任务仅供查看。' : '目标或运行环境已变化，此任务仅供查看。'}</p>}
    {editing && draft ? <form onSubmit={event => { event.preventDefault(); mutate(signal => api.edit(sessionId, record.workflowId, editRevision, draft, signal)); }}><label>任务名称<input aria-label="任务名称" value={draft.title} maxLength={160} onChange={event => setDraft({ ...draft, title: event.target.value })}/></label><ol className="qyt-workflow-checks">{draft.checks.map((check, index) => <li key={check.checkId}><button type="button" aria-label={`删除检查 ${index + 1}`} disabled={busy || draft.checks.length <= 1} onClick={() => setDraft({ ...draft, checks: draft.checks.filter((_, i) => i !== index) })}>删除</button><label>检查项目<input aria-label={`检查项目 ${index + 1}`} value={check.title} maxLength={120} onChange={event => update(index, { title: event.target.value })}/></label><label>预期结果<input aria-label={`预期结果 ${index + 1}`} value={check.expected} maxLength={500} onChange={event => update(index, { expected: event.target.value })}/></label><label className="qyt-workflow-required"><input type="checkbox" checked={check.required} onChange={event => update(index, { required: event.target.checked })}/>必需检查</label>{check.rule.kind === 'browserValue' ? <><label>控件名称<input aria-label={`控件名称 ${index + 1}`} value={check.rule.name} onChange={event => updateRule(index, { name: event.target.value })}/></label><label>控件的预期值<input aria-label={`控件预期值 ${index + 1}`} value={check.rule.expected} onChange={event => updateRule(index, { expected: event.target.value })}/></label></> : check.rule.kind === 'nativeText' ? <label>应用内应出现的完整文字<input aria-label={`应用完整文字 ${index + 1}`} value={check.rule.expected} maxLength={500} onChange={event => updateRule(index, { expected: event.target.value })}/></label> : <p className="qyt-run-note">此项需要额外人工确认：{check.rule.reason}</p>}</li>)}</ol><button type="button" disabled={busy || draft.checks.length >= 32} onClick={addCheck}>添加检查项</button><details><summary>本次任务限制</summary><label>最多操作次数<input aria-label="最多操作次数" type="number" min={1} max={128} value={draft.budget.maxActions} onChange={event => setDraft({ ...draft, budget: { ...draft.budget, maxActions: Number(event.target.value) } })}/></label><label>最多检查次数<input aria-label="最多检查次数" type="number" min={1} max={64} value={draft.budget.maxAttempts} onChange={event => setDraft({ ...draft, budget: { ...draft.budget, maxAttempts: Number(event.target.value) } })}/></label><label>最多证据数<input aria-label="最多证据数" type="number" min={1} max={64} value={draft.budget.maxEvidence} onChange={event => setDraft({ ...draft, budget: { ...draft.budget, maxEvidence: Number(event.target.value) } })}/></label><label>最长用时（秒）<input aria-label="最长用时秒数" type="number" min={1} max={3600} value={draft.budget.deadlineMs / 1000} onChange={event => setDraft({ ...draft, budget: { ...draft.budget, deadlineMs: Number(event.target.value) * 1000 } })}/></label><label>最多申请修复次数<input aria-label="最多申请修复次数" type="number" min={0} max={4} value={draft.maxRepairAttempts} onChange={event => setDraft({ ...draft, maxRepairAttempts: Number(event.target.value) })}/></label></details><div className="qyt-workflow-edit-actions"><button type="submit" disabled={busy}>保存清单</button><button type="button" disabled={busy} onClick={() => setDraft(undefined)}>取消编辑</button></div></form> : <ol className="qyt-workflow-checks">{record?.plan.checks.map(check => { const attempts = run?.record.attempts.filter(a => a.checkId === check.checkId) ?? [], latest = attempts.at(-1); return <li key={check.checkId}><div><strong>{check.title}</strong><span className="qyt-run-muted">{check.required ? '必需' : '可选'} · {latest?.verdict ? RUN_STATE_LABELS[latest.verdict] : latest ? '正在检查' : '尚未检查'}</span></div><p>预期：{check.expected}</p>{attempts.length > 1 && <span className="qyt-run-muted">保留 {attempts.length} 次检查，历史失败可在详情中查看</span>}{check.rule.kind === 'unavailable' && <p className="qyt-run-note">尚无独立校验依据，此项不会自动记为通过。</p>}</li>; })}</ol>}
    {draft && !editing && <p role="status" className="qyt-run-note">清单已在后台冻结或更新。未保存的编辑未覆盖新记录。</p>}
    {record?.repairs.filter(request => request.state === 'pending').map(request => <div className="qyt-workflow-repair" key={request.requestId}><strong>需要尝试一次修复与复验</strong><p>{request.reason}</p><p className="qyt-run-muted">仅限本次任务和剩余预算；文件、应用与站点权限仍按现有授权处理。</p><button type="button" disabled={readonly || busy} onClick={() => mutate(signal => api.repair(sessionId, record.workflowId, record.revision, request.requestId, true, signal))}>允许本次修复</button><button type="button" disabled={readonly || busy} onClick={() => mutate(signal => api.repair(sessionId, record.workflowId, record.revision, request.requestId, false, signal))}>不修复</button></div>)}
    <footer>{record && onTemplates && <button type="button" onClick={() => onTemplates(record.workflowId)}>验收模板</button>}{record?.phase === 'draft' && <button type="button" disabled={readonly || busy} onClick={() => mutate(signal => api.cancel(sessionId, record.workflowId, record.revision, signal))}>放弃本次清单</button>}{editable && !draft && <button type="button" disabled={busy} onClick={() => { setDraft(structuredClone(record.plan)); setEditRevision(record.revision); }}>编辑清单</button>}{run && record?.runId && <button type="button" onClick={() => onOpenRun(record.runId!)}>查看检查与证据</button>}{record && ['running', 'awaitingRepair'].includes(record.phase) && <button type="button" disabled={readonly || busy} onClick={() => mutate(signal => api.cancel(sessionId, record.workflowId, record.revision, signal))}>取消本次验收</button>}<button type="button" disabled={busy} onClick={() => setRefresh(value => value + 1)}>刷新记录</button></footer>
    <p className="qyt-run-note">{record?.phase === 'draft' ? '开始验收时清单会冻结。结果由真实证据与独立校验决定。' : '模型完成操作不代表验收通过，未知结果与缺失证据均会保留。'}</p>
  </section>;
}
