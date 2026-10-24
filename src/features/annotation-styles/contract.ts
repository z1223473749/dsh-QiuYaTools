/** ANN02 temporary feedback contract. No browser, input, DOM mutation or source-writing capability. */
import { AnnotationError, assertAnchor, sameAnchor, setAnnotationNote } from '../annotations/contract.ts';
import type { AnnotationAnchor, AnnotationDraft } from '../annotations/contract.ts';
import type { AnnotationElementSelection, AnnotationSourceCapture } from '../annotations/source-contract.ts';
export const COMPUTED_STYLE_PROPERTIES = Object.freeze(['font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'color', 'background-color', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left'] as const);
export type ComputedStyleProperty = typeof COMPUTED_STYLE_PROPERTIES[number];
export type ComputedStyleValues = Readonly<Record<ComputedStyleProperty, string>>;
export interface StyleBaseline {
    readonly baselineId: string;
    readonly expiresAt: number;
    readonly captureId: string;
    readonly anchor: AnnotationAnchor;
    readonly elementId: string;
    readonly selection: Readonly<{
        role: string;
        name: string;
        rectangle: Readonly<{
            x: number;
            y: number;
            width: number;
            height: number;
        }>;
    }>;
    readonly values: ComputedStyleValues;
}
export type FontPreset = 'system' | 'serif' | 'monospace';
export interface StyleChanges {
    readonly fontFamily?: FontPreset;
    readonly fontSize?: number;
    readonly fontWeight?: number;
    readonly lineHeight?: number;
    readonly letterSpacing?: number;
    readonly color?: string;
    readonly backgroundColor?: string;
    readonly paddingTop?: number;
    readonly paddingRight?: number;
    readonly paddingBottom?: number;
    readonly paddingLeft?: number;
}
export interface StyleDraft {
    readonly id: string;
    readonly baseline: StyleBaseline;
    readonly changes: Readonly<StyleChanges>;
    readonly sample: string;
}
export interface StyleFeedback {
    readonly baselineId: string;
    readonly captureId: string;
    readonly elementId: string;
    readonly anchor: AnnotationAnchor;
    readonly changes: Readonly<StyleChanges>;
    readonly note: string;
}
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/iu;
const invalid = () => new AnnotationError('INVALID_MARK', '样式反馈暂不可用，请重新选取当前网页元素。');
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
export function computedStyleValues(input: unknown): ComputedStyleValues {
    if (!object(input) || Object.keys(input).length !== COMPUTED_STYLE_PROPERTIES.length || Object.keys(input).some(key => !COMPUTED_STYLE_PROPERTIES.includes(key as ComputedStyleProperty)))
        throw invalid();
    const saved: Partial<Record<ComputedStyleProperty, string>> = {};
    for (const key of COMPUTED_STYLE_PROPERTIES) {
        const value = input[key];
        if (typeof value !== 'string' || !value || value.length > (key === 'font-family' ? 320 : 96) || /[\u0000-\u001f\u007f{};]/u.test(value) || /url\s*\(|javascript\s*:/iu.test(value))
            throw invalid();
        saved[key] = value;
    }
    return Object.freeze(saved as Record<ComputedStyleProperty, string>);
}
export function createStyleBaseline(capture: AnnotationSourceCapture, selected: AnnotationElementSelection, values: unknown, baselineId: string = crypto.randomUUID()): StyleBaseline {
    const a = capture.capture.anchor, r = selected.rectangle;
    assertAnchor(a);
    if (!Number.isFinite(capture.expiresAt) || capture.expiresAt <= Date.now() || capture.expiresAt > Date.now() + 120000)
        throw invalid();
    if (!UUID.test(baselineId) || !UUID.test(capture.captureId) || !UUID.test(selected.elementId) || selected.captureId !== capture.captureId || a.kind !== 'browser' || selected.viewportVersion !== a.viewportVersion || typeof selected.role !== 'string' || typeof selected.name !== 'string' || selected.role.length > 128 || selected.name.length > 256 || /[\u0000-\u001f]/u.test(selected.role + selected.name) || !r || ![r.x, r.y, r.width, r.height].every(Number.isFinite) || r.x < 0 || r.y < 0 || r.width < 1 || r.height < 1 || r.x + r.width > a.width || r.y + r.height > a.height)
        throw invalid();
    return Object.freeze({ baselineId, expiresAt: capture.expiresAt, captureId: capture.captureId, anchor: Object.freeze({ ...a, geometry: Object.freeze({ ...a.geometry }) }), elementId: selected.elementId, selection: Object.freeze({ role: selected.role, name: selected.name, rectangle: Object.freeze({ ...r }) }), values: computedStyleValues(values) });
}
const numeric = { fontSize: [8, 72], fontWeight: [100, 900], lineHeight: [.8, 2.4], letterSpacing: [-2, 8], paddingTop: [0, 64], paddingRight: [0, 64], paddingBottom: [0, 64], paddingLeft: [0, 64] } as const;
export function styleChanges(input: unknown): Readonly<StyleChanges> {
    if (!object(input) || Object.keys(input).length > 12)
        throw invalid();
    const result: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(input)) {
        if (key === 'fontFamily') {
            if (!['system', 'serif', 'monospace'].includes(String(value)) || typeof value !== 'string')
                throw invalid();
            result[key] = value;
            continue;
        }
        if (key === 'color' || key === 'backgroundColor') {
            if (typeof value !== 'string' || !/^#[a-f\d]{6}$/iu.test(value) && !(key === 'backgroundColor' && value === 'transparent'))
                throw invalid();
            result[key] = value.toLowerCase();
            continue;
        }
        if (!Object.hasOwn(numeric, key))
            throw invalid();
        const [min, max] = numeric[key as keyof typeof numeric];
        if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || key === 'fontWeight' && (!Number.isInteger(value) || value % 100 !== 0) || key === 'fontSize' && !Number.isInteger(value) || Math.abs(Math.round(value * 100) - value * 100) > 1e-7)
            throw invalid();
        result[key] = value;
    }
    return Object.freeze(result as StyleChanges);
}
export function createStyleDraft(baseline: StyleBaseline, id: string = crypto.randomUUID()): StyleDraft { if (!UUID.test(id) || !UUID.test(baseline.baselineId) || !UUID.test(baseline.captureId) || !UUID.test(baseline.elementId) || !Number.isFinite(baseline.expiresAt) || baseline.expiresAt <= Date.now())
    throw invalid(); assertAnchor(baseline.anchor); const saved = Object.freeze({ ...baseline, anchor: Object.freeze({ ...baseline.anchor, geometry: Object.freeze({ ...baseline.anchor.geometry }) }), selection: Object.freeze({ ...baseline.selection, rectangle: Object.freeze({ ...baseline.selection.rectangle }) }), values: computedStyleValues({ ...baseline.values }) }); return Object.freeze({ id, baseline: saved, changes: Object.freeze({}), sample: baseline.selection.name || '这是一段用于比较样式的文字样例。' }); }
export function changeStyle(draft: StyleDraft, changes: unknown): StyleDraft { return Object.freeze({ ...draft, changes: styleChanges(changes) }); }
export function setStyleSample(draft: StyleDraft, sample: string): StyleDraft { if (typeof sample !== 'string' || sample.length > 256 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(sample))
    throw invalid(); return Object.freeze({ ...draft, sample }); }
export function assertStyleCurrent(baseline: StyleBaseline, current: AnnotationAnchor | undefined, captureId: string | undefined, elementId: string | undefined): void { if (baseline.expiresAt <= Date.now() || !current || !sameAnchor(baseline.anchor, current) || captureId !== baseline.captureId || elementId !== baseline.elementId)
    throw new AnnotationError('STALE_ANCHOR', '画面或选中的元素已变化，请重新选取后给出样式反馈。'); }
const labels: Record<keyof StyleChanges, [
    string,
    ComputedStyleProperty
]> = { fontFamily: ['字体', 'font-family'], fontSize: ['字号', 'font-size'], fontWeight: ['字重', 'font-weight'], lineHeight: ['行距', 'line-height'], letterSpacing: ['字距', 'letter-spacing'], color: ['文字颜色', 'color'], backgroundColor: ['背景颜色', 'background-color'], paddingTop: ['上内边距', 'padding-top'], paddingRight: ['右内边距', 'padding-right'], paddingBottom: ['下内边距', 'padding-bottom'], paddingLeft: ['左内边距', 'padding-left'] };
const fonts = { system: '系统字体', serif: '衬线字体', monospace: '等宽字体' };
export function styleFeedback(draft: StyleDraft, current: AnnotationAnchor | undefined, captureId: string | undefined, elementId: string | undefined): StyleFeedback {
    assertStyleCurrent(draft.baseline, current, captureId, elementId);
    const changes = styleChanges({ ...draft.changes });
    if (!Object.keys(changes).length)
        throw invalid();
    const rows = Object.entries(changes).map(([key, value]) => { const prop = key as keyof StyleChanges, [label, css] = labels[prop], next = prop === 'fontFamily' ? fonts[value as FontPreset] : prop === 'lineHeight' ? value + ' 倍字号' : prop === 'fontSize' || prop === 'letterSpacing' || prop.startsWith('padding') ? value + 'px' : value; return `${label}：${draft.baseline.values[css]} → ${next}`; });
    const note = ['临时样式反馈（尚未修改页面或源码）：', `元素：${draft.baseline.selection.role} ${draft.baseline.selection.name}`, ...rows, '本地样例用于比较字体、间距和颜色；它不代表目标页面已更新。请先重新观察当前页面，再实施并验证实际修改。'].join('\n');
    return Object.freeze({ baselineId: draft.baseline.baselineId, captureId: draft.baseline.captureId, elementId: draft.baseline.elementId, anchor: draft.baseline.anchor, changes, note });
}
/** Untrusted transport projection, checked against the exact already-issued immutable capture/selection. */
export function parseStyleBaseline(value: unknown, capture: AnnotationSourceCapture, selected: AnnotationElementSelection): StyleBaseline {
    if (!object(value) || Object.keys(value).some(k => !['baselineId', 'expiresAt', 'captureId', 'anchor', 'elementId', 'selection', 'values'].includes(k)) || !object(value.anchor) || !object(value.selection) || !object(value.selection.rectangle) || Object.keys(value.selection).some(k => !['role', 'name', 'rectangle'].includes(k)) || Object.keys(value.selection.rectangle).some(k => !['x', 'y', 'width', 'height'].includes(k)) || value.captureId !== capture.captureId || value.elementId !== selected.elementId || value.expiresAt !== capture.expiresAt)
        throw invalid();
    const rectangle = value.selection.rectangle;
    assertAnchor(value.anchor as unknown as AnnotationAnchor);
    if (!sameAnchor(value.anchor as unknown as AnnotationAnchor, capture.capture.anchor) || value.selection.role !== selected.role || value.selection.name !== selected.name || (['x', 'y', 'width', 'height'] as const).some(k => rectangle[k] !== selected.rectangle[k]))
        throw invalid();
    return createStyleBaseline(capture, selected, value.values, typeof value.baselineId === 'string' ? value.baselineId : '');
}
/** Feedback remains attached to its selected element mark. Undoing that mark also removes its advice from submission. */
export function withStyleFeedback(draft: AnnotationDraft, feedbacks: readonly StyleFeedback[]): AnnotationDraft {
    if (feedbacks.length > 8 || new Set(feedbacks.map(f => f.elementId)).size !== feedbacks.length)
        throw invalid();
    const notes: string[] = [];
    for (const feedback of feedbacks) {
        if (!draft.marks.some(m => m.kind === 'element' && m.elementId === feedback.elementId))
            continue;
        if (!sameAnchor(draft.capture.anchor, feedback.anchor) || typeof feedback.note !== 'string' || feedback.note.length > 4000)
            throw invalid();
        notes.push(feedback.note);
    }
    return setAnnotationNote(draft, [draft.note, ...notes].filter(Boolean).join('\n\n'));
}
