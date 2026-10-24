import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { addAnnotation, annotationPoint, createAnnotationDraft, sameAnchor, setAnnotationNote } from './contract.ts';
import type { AnnotationAnchor, AnnotationCapture, AnnotationDraft, AnnotationMark, AnnotationPoint, AnnotationTool } from './contract.ts';
import type { AnnotationSubmission } from './submission.ts';
import type { AnnotationElementSelection } from './source-contract.ts';
import { ANNOTATION_COLOR, arrowHead, annotationTextLines } from './render.ts';
import { ANNOTATION_STYLES } from './styles.ts';
export interface AnnotationEditorProps {
    readonly capture: AnnotationCapture;
    readonly currentAnchor?: AnnotationAnchor;
    readonly submission?: AnnotationSubmission;
    readonly onClose: () => void;
    readonly captureId?: string;
    readonly onElement?: (point: AnnotationPoint, signal: AbortSignal) => Promise<AnnotationElementSelection>;
    readonly onDraftChange?: (draft: AnnotationDraft) => void;
}
const idle = Object.freeze({ state: 'editing' as const, issued: false, message: '' }), noSubscribe = () => () => { }, idleSnapshot = () => idle;
function Mark({ mark, width, height }: {
    mark: AnnotationMark;
    width: number;
    height: number;
}) {
    if (mark.kind === 'text')
        return <g fill={ANNOTATION_COLOR} stroke="none" fontSize={Math.max(14, width / 60)} fontFamily="sans-serif">{annotationTextLines(mark, width, height).map((line, index) => <text key={index} x={line.x} y={line.y} dominantBaseline="hanging">{line.text}</text>)}</g>;
    if (mark.kind === 'element')
        return <rect x={mark.rectangle.x} y={mark.rectangle.y} width={mark.rectangle.width} height={mark.rectangle.height} strokeDasharray="6 3"/>;
    if (mark.kind === 'rectangle')
        return <rect x={Math.min(mark.from.x, mark.to.x)} y={Math.min(mark.from.y, mark.to.y)} width={Math.abs(mark.to.x - mark.from.x)} height={Math.abs(mark.to.y - mark.from.y)}/>;
    const [x1, y1, x2, y2] = arrowHead(mark, width);
    return <path d={`M${mark.from.x},${mark.from.y}L${mark.to.x},${mark.to.y}M${x1},${y1}L${mark.to.x},${mark.to.y}L${x2},${y2}`}/>;
}
/** One frozen frame per editor mount. Opening another frame must mount a new editor. */
export function AnnotationEditor({ capture, currentAnchor, submission, onClose, captureId, onElement, onDraftChange }: AnnotationEditorProps) {
    const [draft, setDraft] = useState(() => createAnnotationDraft(capture)), [tool, setTool] = useState<AnnotationTool>('rectangle'), [gesture, setGesture] = useState<{
        pointerId: number;
        from: AnnotationPoint;
        to: AnnotationPoint;
    }>(), [textAt, setTextAt] = useState<AnnotationPoint>(), [text, setText] = useState(''), [error, setError] = useState(''), [selecting, setSelecting] = useState(false);
    const draftRef = useRef(draft);
    draftRef.current = draft;
    const stage = useRef<HTMLDivElement>(null), composing = useRef(false), mounted = useRef(true), elementController = useRef(new AbortController()), elementInFlight = useRef(false), state = useSyncExternalStore(submission?.subscribe ?? noSubscribe, submission?.getSnapshot ?? idleSnapshot);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; elementController.current.abort(); submission?.dispose(); }; }, [submission]);
    const anchor = draft.capture.anchor, stale = !currentAnchor || !sameAnchor(anchor, currentAnchor) || !sameAnchor(anchor, capture.anchor), editable = !stale && state.state === 'editing' && !selecting, available = submission?.available === true;
    useEffect(() => { if (stale) {
        elementController.current.abort();
        setGesture(undefined);
        setTextAt(undefined);
        if (!state.issued)
            submission?.cancel();
    } }, [stale, state.issued, submission]);
    useEffect(() => { onDraftChange?.(draft); }, [draft, onDraftChange]);
    const map = (x: number, y: number) => { const box = stage.current?.getBoundingClientRect(); return box && annotationPoint({ x, y }, box, anchor); };
    const save = (mark: AnnotationMark) => { try {
        const saved = addAnnotation(draftRef.current, mark);
        draftRef.current = saved;
        setDraft(saved);
        setError('');
    }
    catch (e) {
        setError(e instanceof Error ? e.message : '批注未能添加。');
    } };
    const submit = () => { if (!editable || !available || !submission || textAt)
        return; setError(''); void submission.submit(draft).catch(e => { if (mounted.current)
        setError(e instanceof Error ? e.message : '批注未能提交。'); }); };
    const close = () => { elementController.current.abort(); submission?.cancel(); onClose(); };
    const provisional: AnnotationMark | undefined = gesture && (tool === 'rectangle' || tool === 'arrow') ? { id: 'provisional', kind: tool, from: gesture.from, to: gesture.to } : undefined;
    // A mounted editor must never expose a previous chat's screenshot or note after owner scope changes.
    if (!currentAnchor || currentAnchor.chatSessionId !== anchor.chatSessionId || capture.anchor.chatSessionId !== anchor.chatSessionId)
        return <section className="qyt-ann" aria-label="画面批注"><style>{ANNOTATION_STYLES}</style><header><h3>画面批注</h3><button type="button" onClick={close}>关闭</button></header><p role="alert">画面或当前聊天已变化，请关闭批注后重新打开。</p></section>;
    return <section className="qyt-ann" aria-label="画面批注" onPointerDown={e => e.stopPropagation()} onKeyDown={e => { e.stopPropagation(); if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !composing.current && !e.nativeEvent.isComposing) {
        e.preventDefault();
        submit();
    } }} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}>
    <style>{ANNOTATION_STYLES}</style><header><div><h3>画面批注</h3><p className="qyt-ann-muted">在这张画面上标注，再发送到当前聊天。</p></div><button type="button" onClick={close}>{state.issued ? '关闭' : '取消'}</button></header>
    <div className="qyt-ann-toolbar" aria-label="批注工具">{([['rectangle', '框选'], ['arrow', '箭头'], ['text', '文字']] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={tool === value} disabled={!editable} onClick={() => { setTool(value); setGesture(undefined); setTextAt(undefined); }}>{label}</button>)}<button type="button" disabled={!editable || !onElement || !captureId} aria-pressed={tool === 'element'} title={onElement ? '只读选取当前网页元素，不点击网页' : '此画面不支持网页元素批注'} onClick={() => { setTool('element'); setGesture(undefined); setTextAt(undefined); }}>网页元素</button><button type="button" disabled={!editable || !draft.marks.length} onClick={() => setDraft(previous => Object.freeze({ ...previous, marks: Object.freeze(previous.marks.slice(0, -1)) }))}>撤销</button></div>
    <div ref={stage} className="qyt-ann-stage" aria-label="批注画布">
      <img src={'data:' + draft.capture.mediaType + ';base64,' + draft.capture.imageBase64} alt="本次批注的冻结画面" draggable={false}/>
      <svg viewBox={`0 0 ${anchor.width} ${anchor.height}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label="批注覆盖层" fill="none" stroke={ANNOTATION_COLOR} strokeWidth={Math.max(2, anchor.width / 400)} strokeLinejoin="round" strokeLinecap="round" onPointerDown={e => {
            e.preventDefault();
            e.stopPropagation();
            if (!editable || elementInFlight.current || e.button !== 0)
                return;
            const p = map(e.clientX, e.clientY);
            if (!p)
                return;
            if (tool === 'text') {
                setTextAt(p);
                setText('');
                return;
            }
            ;
            if (tool === 'element') {
                if (!onElement || !captureId || elementController.current.signal.aborted)
                    return;
                elementInFlight.current = true;
                setSelecting(true);
                setError('');
                void onElement(p, elementController.current.signal).then(value => {
                    if (!mounted.current || elementController.current.signal.aborted)
                        return;
                    if (value.captureId !== captureId || value.viewportVersion !== anchor.viewportVersion)
                        throw Error('网页元素已失效，请重新截取。');
                    save({ id: crypto.randomUUID(), kind: 'element', elementId: value.elementId, viewportVersion: value.viewportVersion, role: value.role, name: value.name, rectangle: value.rectangle });
                }).catch(error => { if (mounted.current && !elementController.current.signal.aborted)
                    setError(error instanceof Error ? error.message : '网页元素未能定位。'); }).finally(() => { elementInFlight.current = false; if (mounted.current)
                    setSelecting(false); });
                return;
            }
            ;
            setGesture({ pointerId: e.pointerId, from: p, to: p });
            e.currentTarget.setPointerCapture?.(e.pointerId);
        }} onPointerMove={e => { if (!editable || !gesture || e.pointerId !== gesture.pointerId)
        return; const p = map(e.clientX, e.clientY); if (p)
        setGesture({ ...gesture, to: p }); }} onPointerUp={e => { if (!editable || !gesture || e.pointerId !== gesture.pointerId)
        return; const p = map(e.clientX, e.clientY); if (p && (tool === 'rectangle' || tool === 'arrow'))
        save({ id: crypto.randomUUID(), kind: tool, from: gesture.from, to: p }); setGesture(undefined); if (e.currentTarget.hasPointerCapture?.(e.pointerId))
        e.currentTarget.releasePointerCapture(e.pointerId); }} onPointerCancel={() => setGesture(undefined)}>{draft.marks.map(mark => <Mark key={mark.id} mark={mark} width={anchor.width} height={anchor.height}/>)}{provisional && <g opacity=".5"><Mark mark={provisional} width={anchor.width} height={anchor.height}/></g>}</svg>
    </div>
    {textAt && editable && <div><label>添加文字<textarea aria-label="标注文字" value={text} maxLength={2000} onChange={e => setText(e.target.value)} autoFocus/></label><div className="qyt-ann-toolbar"><button type="button" disabled={!text.trim()} onClick={() => { save({ id: crypto.randomUUID(), kind: 'text', at: textAt, text }); setTextAt(undefined); setText(''); }}>添加文字</button><button type="button" onClick={() => setTextAt(undefined)}>放弃文字</button></div></div>}
    <ol className="qyt-ann-marks" aria-label="已添加的批注">{draft.marks.map((mark, i) => <li key={mark.id}><button type="button" disabled={!editable} aria-label={`删除第 ${i + 1} 条批注`} onClick={() => setDraft(previous => Object.freeze({ ...previous, marks: Object.freeze(previous.marks.filter(m => m.id !== mark.id)) }))}>{i + 1}. {mark.kind === 'text' ? '文字' : mark.kind === 'arrow' ? '箭头' : mark.kind === 'element' ? '网页元素' : '选框'} ×</button></li>)}</ol>
    <label>补充说明<textarea aria-label="批注说明" value={draft.note} maxLength={8000} disabled={!editable} placeholder="告诉 Harness 你希望如何调整或操作…" onChange={e => setDraft(previous => setAnnotationNote(previous, e.target.value))}/></label>
    {stale ? <p className="qyt-ann-warning" role="alert">画面已变化，请关闭此草稿并重新截取后批注。</p> : !available ? <p className="qyt-ann-warning">当前工作台尚未提供画面版本核验，批注暂时不能发送。草稿只保留在此窗口。</p> : <p className="qyt-ann-muted">编辑批注不会点击真实应用。只有点击发送后，图片和说明才会交给当前聊天。</p>}
    {selecting && <p role="status">正在只读定位网页元素…</p>}{error && <p role="alert">{error}</p>}{state.message && <p role="status">{state.message}</p>}
    <footer><span className="qyt-ann-muted">{draft.marks.length} 条批注</span><button className="qyt-ann-primary" type="button" disabled={!editable || !available || !!textAt || (!draft.marks.length && !draft.note.trim())} onClick={submit}>发送到当前聊天</button></footer>
  </section>;
}
