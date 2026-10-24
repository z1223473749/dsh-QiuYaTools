import React, { useEffect, useRef, useState } from 'react';
import type { TemplateView } from './contract.ts';
import type { TemplateAPI, SaveTemplateInput } from './client-api.ts';
import type { TemplateComparison } from './contract.ts';
import type { RerunInput, RerunReceipt } from './rerun-submission.ts';
const labels: Record<string, string> = { passed: '通过', failed: '失败', blocked: '受阻', cancelled: '已取消', inconclusive: '未能确认', pending: '检查中', 'not-run': '尚未检查' };
export function TemplatesPane({ chatSessionId, sourceWorkflowId, api, rerun, current }: {
    chatSessionId: string;
    sourceWorkflowId?: string;
    api: TemplateAPI;
    rerun(chat: string, input: RerunInput, signal: AbortSignal): Promise<RerunReceipt>;
    current(chat: string): boolean;
}) {
    const [rows, setRows] = useState<TemplateView[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false), [unknown, setUnknown] = useState(false), [refresh, setRefresh] = useState(0), [name, setName] = useState(''), [description, setDescription] = useState(''), [label, setLabel] = useState('1.0'), [destination, setDestination] = useState(''), [comparison, setComparison] = useState<TemplateComparison>(), [message, setMessage] = useState('');
    const lifetime = useRef<AbortController>(), pending = useRef(false), scopeKey = chatSessionId + ':' + (sourceWorkflowId ?? '');
    const [renderScope, setRenderScope] = useState('');
    useEffect(() => { const c = new AbortController(); lifetime.current = c; pending.current = false; setRenderScope(scopeKey); setRows([]); setName(''); setDescription(''); setLabel('1.0'); setDestination(''); setError(''); setComparison(undefined); setBusy(false); setMessage(''); setUnknown(false); void api.list(chatSessionId, c.signal).then(value => { if (!c.signal.aborted && current(chatSessionId))
        setRows(value); }, () => { if (!c.signal.aborted && current(chatSessionId))
        setError('模板暂不可用，请刷新后重试。'); }); return () => c.abort(); }, [api, chatSessionId, sourceWorkflowId, current, refresh]);
    if (!current(chatSessionId) || renderScope !== scopeKey)
        return null;
    const run = (work: (signal: AbortSignal) => Promise<void>) => { const c = lifetime.current; if (!c || c.signal.aborted || pending.current || unknown || !current(chatSessionId))
        return; pending.current = true; setBusy(true); setError(''); void work(c.signal).catch(() => { if (!c.signal.aborted && current(chatSessionId)) {
        setUnknown(true);
        setError('本次操作结果尚未确认。请查看当前记录，不要重复提交。');
    } }).finally(() => { if (!c.signal.aborted && current(chatSessionId)) {
        pending.current = false;
        setBusy(false);
    } }); };
    const replace = (view: TemplateView) => { if (current(chatSessionId))
        setRows(before => [view, ...before.filter(row => row.record.templateId !== view.record.templateId)]); };
    const save = () => run(async (signal) => { if (!sourceWorkflowId || !name.trim() || !label.trim())
        return; const before = rows.find(row => row.record.templateId === destination), input: SaveTemplateInput = { templateId: before?.record.templateId ?? null, expectedRevision: before?.record.revision ?? 0, workflowId: sourceWorkflowId, name: name.trim(), description: description.trim(), label: label.trim(), operationId: crypto.randomUUID() }; const value = await api.save(chatSessionId, input, signal); signal.throwIfAborted(); if (current(chatSessionId)) {
        replace(value);
        setMessage('已保存清单版本。权限、控制与验收结果均不会复制。');
    } });
    return <section className="qyt-run qyt-template-pane" aria-label="验收模板"><header><strong>验收模板</strong><button type="button" disabled={busy} onClick={() => setRefresh(n => n + 1)}>刷新</button></header><p className="qyt-run-note">保存可复用的检查清单。再次验收会在当前会话创建新任务，重新观察并核对当前权限。</p>{error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {sourceWorkflowId && <details className="qyt-template-save"><summary>保存当前清单为模板</summary><label>保存位置<select aria-label="模板保存位置" value={destination} disabled={busy || unknown} onChange={e => { setDestination(e.target.value); const v = rows.find(v => v.record.templateId === e.target.value); if (v) {
        setName(v.record.name);
        setDescription(v.record.description);
    } }}><option value="">新建模板</option>{rows.filter(v => !v.readOnly).map(v => <option key={v.record.templateId} value={v.record.templateId}>{v.record.name} · 新增版本</option>)}</select></label><label>模板名称<input aria-label="模板名称" maxLength={120} value={name} disabled={busy || unknown} onChange={e => setName(e.target.value)}/></label><label>清单版本<input aria-label="清单版本" maxLength={80} value={label} disabled={busy || unknown} onChange={e => setLabel(e.target.value)}/></label><label>说明<input aria-label="模板说明" maxLength={500} value={description} disabled={busy || unknown} onChange={e => setDescription(e.target.value)}/></label><button type="button" disabled={busy || unknown || !name.trim() || !label.trim()} onClick={save}>保存清单版本</button></details>}
    {!rows.length && !error && <p className="qyt-run-muted">尚未保存验收模板。可从自动验收卡片保存当前清单。</p>}
    <div className="qyt-template-list">{rows.map(view => <TemplateItem key={view.record.templateId} view={view} disabled={busy || unknown} onRerun={(versionId, versionLabel) => run(async (signal) => { const receipt = await rerun(chatSessionId, { templateId: view.record.templateId, versionId, versionLabel }, signal); signal.throwIfAborted(); if (!current(chatSessionId))
        return; if (receipt === 'unknown') {
        setUnknown(true);
        setMessage('提交尚未确认，请查看当前会话，勿重复发送。');
    }
    else
        setMessage(receipt === 'delivered' ? '请求已出现在当前会话，等待模型生成新的验收清单。' : '当前会话未接受此请求，尚未开始验收。'); })} onRevoke={() => run(async (signal) => { const value = await api.revoke(chatSessionId, view.record.templateId, view.record.revision, signal); signal.throwIfAborted(); if (current(chatSessionId))
        replace(value); })} onCompare={(left, right) => run(async (signal) => { const value = await api.compare(chatSessionId, view.record.templateId, left, right, signal); signal.throwIfAborted(); if (current(chatSessionId))
        setComparison(value); })}/>)}</div>
    {comparison && <section className="qyt-template-comparison" aria-label="版本对比"><h3>版本对比</h3><p className="qyt-run-note">仅比较本会话的真实记录，保留每次失败与后续复验。条件变化的检查不直接比较。</p>{(!comparison.leftTemplatePlanMatches || !comparison.rightTemplatePlanMatches) && <p role="status">本次清单曾经编辑，按实际冻结的检查条件显示差异。</p>}<table><thead><tr><th>检查</th><th>前一次</th><th>后一次</th></tr></thead><tbody>{comparison.checks.map(row => <tr key={row.checkId}><th>{row.title}{!row.comparable && <small>条件已变化</small>}</th><td>{labels[row.left]}</td><td>{labels[row.right]}</td></tr>)}</tbody></table><p className="qyt-run-muted">保留历史检查：{comparison.left.run?.record.attempts.length ?? 0} 次 / {comparison.right.run?.record.attempts.length ?? 0} 次。历史通过不会用于本次未完成的检查。</p></section>}
    </section>;
}
function TemplateItem({ view, disabled, onRerun, onRevoke, onCompare }: {
    view: TemplateView;
    disabled: boolean;
    onRerun(versionId: string, label: string): void;
    onRevoke(): void;
    onCompare(left: string, right: string): void;
}) {
    const r = view.record, [version, setVersion] = useState(r.versions.at(-1)!.versionId), [versionLabel, setVersionLabel] = useState(''), [left, setLeft] = useState(''), [right, setRight] = useState('');
    return <article className="qyt-template-item"><header><strong>{r.name}</strong><span>{view.canPrepare ? '可使用' : '已撤销'}</span></header>{r.description && <p>{r.description}</p>}<label>使用清单版本<select aria-label={'清单版本 · ' + r.name} value={version} disabled={disabled || !view.canPrepare} onChange={e => setVersion(e.target.value)}>{r.versions.map(v => <option key={v.versionId} value={v.versionId}>{v.label} · {v.plan.checks.length} 项检查</option>)}</select></label><label>本次被测版本<input aria-label={'本次被测版本 · ' + r.name} value={versionLabel} maxLength={120} disabled={disabled || !view.canPrepare} onChange={e => setVersionLabel(e.target.value)}/></label><footer><button type="button" disabled={disabled || !view.canPrepare || !versionLabel.trim()} onClick={() => onRerun(version, versionLabel.trim())}>再次验收</button><button type="button" disabled={disabled || !view.canPrepare} onClick={onRevoke}>撤销模板</button></footer>{r.executions.length > 1 && <details><summary>比较本会话的运行</summary><label>前一次<select aria-label={'前一次运行 · ' + r.name} value={left} disabled={disabled} onChange={e => setLeft(e.target.value)}><option value="">请选择</option>{r.executions.map(v => <option key={v.workflowId} value={v.workflowId}>{v.versionLabel} · {new Date(v.createdAt).toLocaleString()}</option>)}</select></label><label>后一次<select aria-label={'后一次运行 · ' + r.name} value={right} disabled={disabled} onChange={e => setRight(e.target.value)}><option value="">请选择</option>{r.executions.map(v => <option key={v.workflowId} value={v.workflowId}>{v.versionLabel} · {new Date(v.createdAt).toLocaleString()}</option>)}</select></label><button type="button" disabled={disabled || !left || !right || left === right} onClick={() => onCompare(left, right)}>查看对比</button></details>}</article>;
}
