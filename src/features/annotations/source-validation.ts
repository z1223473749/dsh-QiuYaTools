/** Whitelisted annotation DTOs. These functions carry no browser or device capability. */
import { AnnotationError, assertAnchor, decodeBase64, sha256 } from './contract.ts';
import type { AnnotationAnchor, AnnotationCapture, AnnotationPoint } from './contract.ts';
import { uuid } from '../workbench/contract.ts';
import { requireIdentity } from '../computer-use/contract.ts';
import type { AnnotationElementSelection, AnnotationFrameVerification, AnnotationSourceCapture, AnnotationSourceCheck, AnnotationSourceTarget } from './source-contract.ts';
const invalid = () => new AnnotationError('INVALID_FRAME', '批注画面数据无效，请重新截取。');
export function annotationObject(v: unknown, fields?: readonly string[]): Record<string, unknown> { if (!v || typeof v !== 'object' || Array.isArray(v) || fields && Object.keys(v).some(key => !fields.includes(key)))
    throw invalid(); return v as Record<string, unknown>; }
function text(v: unknown, max: number, empty = false): string { if (typeof v !== 'string' || (!empty && !v.length) || v.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v))
    throw invalid(); return v; }
function num(v: unknown, min: number, max: number, integer = false): number { if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || integer && !Number.isSafeInteger(v))
    throw invalid(); return v; }
const hash = (v: unknown): string => { if (typeof v !== 'string' || !/^[a-f0-9]{64}$/u.test(v))
    throw invalid(); return v; };
export function annotationTarget(value: unknown, chat: string): AnnotationSourceTarget {
    const v = annotationObject(value);
    if (v.chatSessionId !== chat || (v.kind !== 'browser' && v.kind !== 'desktop'))
        throw invalid();
    return Object.freeze({ chatSessionId: requireIdentity(chat), environmentId: uuid(v.environmentId), workbenchTabId: uuid(v.workbenchTabId), targetId: requireIdentity(v.targetId), appId: requireIdentity(v.appId), kind: v.kind as 'browser' | 'desktop', epoch: num(v.epoch, 0, Number.MAX_SAFE_INTEGER, true) });
}
export function annotationAnchor(value: unknown, chat: string): AnnotationAnchor {
    const v = annotationObject(value), t = annotationTarget(v, chat), g = annotationObject(v.geometry);
    const anchor: AnnotationAnchor = Object.freeze({ ...t, frameId: requireIdentity(v.frameId), geometry: Object.freeze({ x: num(g.x, -100000, 100000), y: num(g.y, -100000, 100000), width: num(g.width, 1, 100000), height: num(g.height, 1, 100000), scale: num(g.scale, .1, 16) }), width: num(v.width, 1, 16384, true), height: num(v.height, 1, 16384, true), imageSHA256: hash(v.imageSHA256), viewportVersion: text(v.viewportVersion, 512) });
    assertAnchor(anchor);
    return anchor;
}
export async function annotationCapture(value: unknown, chat: string): Promise<AnnotationSourceCapture> {
    const v = annotationObject(value), c = annotationObject(v.capture), anchor = annotationAnchor(c.anchor, chat), imageBase64 = text(c.imageBase64, 24 * 1024 * 1024);
    if (c.mediaType !== 'image/jpeg' || typeof v.elementHitTest !== 'boolean')
        throw invalid();
    const bytes = decodeBase64(imageBase64);
    if (bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217 || await sha256(bytes) !== anchor.imageSHA256)
        throw invalid();
    const capture: AnnotationCapture = Object.freeze({ anchor, imageBase64, mediaType: 'image/jpeg' });
    return Object.freeze({ captureId: uuid(v.captureId), capture, expiresAt: num(v.expiresAt, 1, Number.MAX_SAFE_INTEGER, true), elementHitTest: v.elementHitTest });
}
function verification(value: unknown): AnnotationFrameVerification { const v = annotationObject(value); return Object.freeze({ frameId: requireIdentity(v.frameId), imageSHA256: hash(v.imageSHA256), viewportVersion: text(v.viewportVersion, 512) }); }
export function annotationCheck(value: unknown, chat: string, captureId: string): AnnotationSourceCheck {
    const v = annotationObject(value);
    if (v.captureId !== captureId || typeof v.valid !== 'boolean')
        throw invalid();
    if (v.valid)
        return Object.freeze({ captureId, valid: true, anchor: annotationAnchor(v.anchor, chat), checkedAgainst: verification(v.checkedAgainst) });
    const reasons = ['navigation', 'scroll', 'geometry', 'pixels', 'epoch', 'expired', 'element', 'unavailable'] as const;
    if (!reasons.some(reason => reason === v.reason))
        throw invalid();
    return Object.freeze({ captureId, valid: false, reason: v.reason as typeof reasons[number], ...(v.checkedAgainst === undefined ? {} : { checkedAgainst: verification(v.checkedAgainst) }) });
}
export function annotationPointDTO(value: unknown): AnnotationPoint { const v = annotationObject(value, ['x', 'y']); return Object.freeze({ x: num(v.x, 0, 16384), y: num(v.y, 0, 16384) }); }
export function annotationElement(value: unknown, captureId: string, anchor: AnnotationAnchor): AnnotationElementSelection {
    const v = annotationObject(value), box = annotationObject(v.rectangle), rectangle = Object.freeze({ x: num(box.x, 0, anchor.width), y: num(box.y, 0, anchor.height), width: num(box.width, 1, anchor.width), height: num(box.height, 1, anchor.height) });
    if (v.captureId !== captureId || v.viewportVersion !== anchor.viewportVersion || rectangle.x + rectangle.width > anchor.width || rectangle.y + rectangle.height > anchor.height)
        throw invalid();
    return Object.freeze({ captureId, elementId: uuid(v.elementId), viewportVersion: text(v.viewportVersion, 512), role: text(v.role, 128, true).replace(/\s+/gu, ' '), name: text(v.name, 256, true).replace(/\s+/gu, ' '), rectangle });
}
