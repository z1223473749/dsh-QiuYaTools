import { useSyncExternalStore } from 'react';
import { AnnotationEditor } from './Editor.tsx';
import type { AnnotationEditorSession } from './session.ts';
/** WorkbenchSurface is unmounted while this editor is present; drawing cannot reach a humanAct handler. */
export function AnnotationSessionView({ session, onClose }: {
    session: AnnotationEditorSession;
    onClose(): void;
}) {
    const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
    return <div className="qyt-ann-workbench" role="region" aria-label="批注编辑区" tabIndex={0} data-qyt-annotation-capture={session.source.captureId} data-invalid={state.invalid}><AnnotationEditor capture={session.source.capture} captureId={session.source.captureId} currentAnchor={session.currentAnchor()} submission={session.submission} onClose={onClose} onDraftChange={session.onDraftChange} {...(session.source.elementHitTest ? { onElement: session.element } : {})}/>{state.message && <p className="qyt-workbench-note" role="status">{state.message}</p>}</div>;
}
