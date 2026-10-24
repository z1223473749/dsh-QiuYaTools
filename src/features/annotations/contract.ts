/** Frozen preview annotations. This module has no device action capability. */
import type { WorkbenchFrame } from '../workbench/client-api.ts';
export interface AnnotationAnchor {
    readonly chatSessionId: string;
    readonly environmentId: string;
    readonly workbenchTabId: string;
    readonly targetId: string;
    readonly appId: string;
    readonly kind: 'browser' | 'desktop';
    readonly epoch: number;
    readonly frameId: string;
    readonly geometry: Readonly<{
        x: number;
        y: number;
        width: number;
        height: number;
        scale: number;
    }>;
    readonly width: number;
    readonly height: number;
    readonly imageSHA256: string;
    /** Host-owned document/viewport revision, when the integration exposes it. */
    readonly viewportVersion?: string;
}
export interface AnnotationCapture {
    readonly anchor: AnnotationAnchor;
    readonly imageBase64: string;
    readonly mediaType: 'image/jpeg';
}
export interface AnnotationPoint {
    readonly x: number;
    readonly y: number;
}
export type AnnotationMark = {
    readonly id: string;
    readonly kind: 'rectangle';
    readonly from: AnnotationPoint;
    readonly to: AnnotationPoint;
} | {
    readonly id: string;
    readonly kind: 'arrow';
    readonly from: AnnotationPoint;
    readonly to: AnnotationPoint;
} | {
    readonly id: string;
    readonly kind: 'text';
    readonly at: AnnotationPoint;
    readonly text: string;
} | {
    readonly id: string;
    readonly kind: 'element';
    readonly elementId: string;
    readonly viewportVersion: string;
    readonly role: string;
    readonly name: string;
    readonly rectangle: Readonly<{
        x: number;
        y: number;
        width: number;
        height: number;
    }>;
};
export interface AnnotationDraft {
    readonly id: string;
    readonly capture: AnnotationCapture;
    readonly marks: readonly AnnotationMark[];
    readonly note: string;
}
export type AnnotationTool = AnnotationMark['kind'];
export class AnnotationError extends Error {
    constructor(readonly code: 'INVALID_FRAME' | 'STALE_ANCHOR' | 'INVALID_MARK' | 'OWNER_CHANGED' | 'UNAVAILABLE' | 'ALREADY_ISSUED', message: string) { super(message); this.name = 'AnnotationError'; }
}
const token = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f]/u.test(value);
const finite = (value: number, min: number, max: number) => Number.isFinite(value) && value >= min && value <= max;
export function assertAnchor(a: AnnotationAnchor): void {
    if (![a.chatSessionId, a.environmentId, a.workbenchTabId, a.targetId, a.appId, a.frameId].every(token) || !['browser', 'desktop'].includes(a.kind) || !Number.isSafeInteger(a.epoch) || a.epoch < 0 || !/^[a-f0-9]{64}$/u.test(a.imageSHA256) || !Number.isSafeInteger(a.width) || !Number.isSafeInteger(a.height) || a.width < 1 || a.height < 1 || a.width > 16384 || a.height > 16384 || a.width * a.height > 40000000 || !a.geometry || !finite(a.geometry.x, -100000, 100000) || !finite(a.geometry.y, -100000, 100000) || !finite(a.geometry.width, 1, 100000) || !finite(a.geometry.height, 1, 100000) || !finite(a.geometry.scale, .1, 16) || (a.viewportVersion !== undefined && !token(a.viewportVersion)))
        throw new AnnotationError('INVALID_FRAME', '此画面暂时不能批注，请重新获取预览。');
}
export function sameAnchor(a: AnnotationAnchor, b: AnnotationAnchor): boolean {
    assertAnchor(a);
    assertAnchor(b);
    return a.chatSessionId === b.chatSessionId && a.environmentId === b.environmentId && a.workbenchTabId === b.workbenchTabId && a.targetId === b.targetId && a.appId === b.appId && a.kind === b.kind && a.epoch === b.epoch && a.frameId === b.frameId && a.width === b.width && a.height === b.height && a.imageSHA256 === b.imageSHA256 && a.viewportVersion === b.viewportVersion && a.geometry.x === b.geometry.x && a.geometry.y === b.geometry.y && a.geometry.width === b.geometry.width && a.geometry.height === b.geometry.height && a.geometry.scale === b.geometry.scale;
}
export function assertCurrentAnchor(a: AnnotationAnchor, current: AnnotationAnchor | undefined): void {
    if (!current || !sameAnchor(a, current))
        throw new AnnotationError('STALE_ANCHOR', '画面已变化，请重新截取后批注。');
}
export function decodeBase64(value: string): Uint8Array {
    if (!value || value.length > 24 * 1024 * 1024 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value))
        throw new AnnotationError('INVALID_FRAME', '画面数据无效。');
    const binary = atob(value), bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    if (btoa(binary) !== value)
        throw new AnnotationError('INVALID_FRAME', '画面数据无效。');
    return bytes;
}
export async function sha256(bytes: Uint8Array): Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer)), n => n.toString(16).padStart(2, '0')).join(''); }
export async function captureAnnotation(frame: WorkbenchFrame, viewportVersion?: string): Promise<AnnotationCapture> {
    // Copy fields before awaiting crypto. A caller mutating its preview object cannot retarget this capture.
    const { target: t, observation: o } = frame, anchor = { chatSessionId: t.chatSessionId, environmentId: t.environmentId, workbenchTabId: t.workbenchTabId, targetId: t.targetId, appId: t.appId, kind: t.kind, epoch: t.epoch, frameId: o.frameId, geometry: Object.freeze({ ...o.geometry }), width: o.width, height: o.height, imageSHA256: '', ...(viewportVersion === undefined ? {} : { viewportVersion }) }, imageBase64 = o.imageBase64;
    if (o.targetId !== t.targetId || o.mediaType !== 'image/jpeg')
        throw new AnnotationError('INVALID_FRAME', '画面归属无效。');
    const bytes = decodeBase64(imageBase64);
    if (bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217)
        throw new AnnotationError('INVALID_FRAME', '画面格式无效。');
    anchor.imageSHA256 = await sha256(bytes);
    assertAnchor(anchor);
    return Object.freeze({ anchor: Object.freeze(anchor), imageBase64, mediaType: 'image/jpeg' as const });
}
export function createAnnotationDraft(capture: AnnotationCapture, id: string = crypto.randomUUID()): AnnotationDraft {
    assertAnchor(capture.anchor);
    if (!token(id))
        throw new AnnotationError('INVALID_MARK', '批注编号无效。');
    // Deep copy the anchor instead of trusting that a caller has frozen it.
    const anchor = Object.freeze({ ...capture.anchor, geometry: Object.freeze({ ...capture.anchor.geometry }) });
    return Object.freeze({ id, capture: Object.freeze({ ...capture, anchor }), marks: Object.freeze([]), note: '' });
}
function point(p: AnnotationPoint, anchor: AnnotationAnchor): Readonly<AnnotationPoint> {
    if (!p || !finite(p.x, 0, anchor.width) || !finite(p.y, 0, anchor.height))
        throw new AnnotationError('INVALID_MARK', '请在画面内标注。');
    return Object.freeze({ x: p.x, y: p.y });
}
export function addAnnotation(draft: AnnotationDraft, mark: AnnotationMark): AnnotationDraft {
    if (draft.marks.length >= 64 || !token(mark.id) || draft.marks.some(m => m.id === mark.id))
        throw new AnnotationError('INVALID_MARK', '批注数量或编号无效。');
    let saved: AnnotationMark;
    if (mark.kind === 'text') {
        if (typeof mark.text !== 'string' || !mark.text.trim() || mark.text.length > 2000)
            throw new AnnotationError('INVALID_MARK', '请输入不超过 2000 字的批注。');
        saved = Object.freeze({ id: mark.id, kind: mark.kind, at: point(mark.at, draft.capture.anchor), text: mark.text });
    }
    else if (mark.kind === 'rectangle' || mark.kind === 'arrow') {
        const from = point(mark.from, draft.capture.anchor), to = point(mark.to, draft.capture.anchor);
        if (Math.hypot(to.x - from.x, to.y - from.y) < 2 || (mark.kind === 'rectangle' && (Math.abs(to.x - from.x) < 2 || Math.abs(to.y - from.y) < 2)))
            throw new AnnotationError('INVALID_MARK', '请拖动选取更大的区域。');
        saved = Object.freeze({ id: mark.id, kind: mark.kind, from, to });
    }
    else if (mark.kind === 'element') {
        const a = draft.capture.anchor, r = mark.rectangle;
        if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(mark.elementId) || !a.viewportVersion || mark.viewportVersion !== a.viewportVersion || typeof mark.role !== 'string' || typeof mark.name !== 'string' || mark.role.length > 128 || mark.name.length > 256 || /[\u0000-\u001f]/u.test(mark.role + mark.name) || !r || !finite(r.x, 0, a.width) || !finite(r.y, 0, a.height) || !finite(r.width, 1, a.width) || !finite(r.height, 1, a.height) || r.x + r.width > a.width || r.y + r.height > a.height)
            throw new AnnotationError('INVALID_MARK', '网页元素已失效，请重新选取。');
        saved = Object.freeze({ id: mark.id, kind: 'element', elementId: mark.elementId, viewportVersion: mark.viewportVersion, role: mark.role, name: mark.name, rectangle: Object.freeze({ ...r }) });
    }
    else
        throw new AnnotationError('INVALID_MARK', '不支持此批注工具。');
    const marks = Object.freeze([...draft.marks, saved]);
    if (marks.reduce((n, m) => n + (m.kind === 'text' ? m.text.length : m.kind === 'element' ? m.role.length + m.name.length : 0), 0) > 16000)
        throw new AnnotationError('INVALID_MARK', '批注文字过多，请适当精简。');
    return Object.freeze({ ...draft, marks });
}
export function setAnnotationNote(draft: AnnotationDraft, note: string): AnnotationDraft {
    if (typeof note !== 'string' || note.length > 8000)
        throw new AnnotationError('INVALID_MARK', '说明不能超过 8000 字。');
    return Object.freeze({ ...draft, note });
}
/** Letterboxed preview -> original image coordinates. No screen or CDP coordinates leave this module. */
export function annotationPoint(client: AnnotationPoint, box: {
    left: number;
    top: number;
    width: number;
    height: number;
}, anchor: AnnotationAnchor): AnnotationPoint | undefined {
    if (![client.x, client.y, box.left, box.top, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0)
        return undefined;
    const scale = Math.min(box.width / anchor.width, box.height / anchor.height), left = box.left + (box.width - anchor.width * scale) / 2, top = box.top + (box.height - anchor.height * scale) / 2, x = (client.x - left) / scale, y = (client.y - top) / scale;
    return x < 0 || y < 0 || x > anchor.width || y > anchor.height ? undefined : { x, y };
}
