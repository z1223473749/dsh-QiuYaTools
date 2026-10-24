/** Browser canvas export of a frozen frame. Never captures the live desktop. */
import { AnnotationError, addAnnotation, createAnnotationDraft, decodeBase64, setAnnotationNote, sha256 } from './contract.ts';
import type { AnnotationDraft, AnnotationMark } from './contract.ts';
export interface AnnotationImage {
    readonly data: string;
    readonly mediaType: 'image/png';
    readonly width: number;
    readonly height: number;
    readonly sha256: string;
}
export const ANNOTATION_COLOR = '#147e91';
export function validateAnnotationDraft(draft: AnnotationDraft): AnnotationDraft {
    let safe = createAnnotationDraft(draft.capture, draft.id);
    for (const mark of draft.marks)
        safe = addAnnotation(safe, mark);
    return setAnnotationNote(safe, draft.note);
}
/** Shared drawing geometry; all lengths are original image pixels. */
export function arrowHead(mark: Extract<AnnotationMark, {
    kind: 'arrow';
}>, width: number): readonly [
    number,
    number,
    number,
    number
] {
    const angle = Math.atan2(mark.to.y - mark.from.y, mark.to.x - mark.from.x), size = Math.min(Math.hypot(mark.to.x - mark.from.x, mark.to.y - mark.from.y) / 3, Math.max(10, width / 80));
    return [mark.to.x - size * Math.cos(angle - Math.PI / 6), mark.to.y - size * Math.sin(angle - Math.PI / 6), mark.to.x - size * Math.cos(angle + Math.PI / 6), mark.to.y - size * Math.sin(angle + Math.PI / 6)];
}
export function annotationTextLines(mark: Extract<AnnotationMark, {
    kind: 'text';
}>, width: number, height: number): readonly {
    text: string;
    x: number;
    y: number;
    maxWidth: number;
}[] {
    const font = Math.max(14, width / 60), maxWidth = Math.max(1, width - mark.at.x - 4), columns = Math.max(1, Math.floor(maxWidth / (font * .7))), rows = Math.max(0, Math.floor((height - mark.at.y) / (font * 1.35))), lines: {
        text: string;
        x: number;
        y: number;
        maxWidth: number;
    }[] = [];
    let row = '', y = mark.at.y;
    const flush = () => { if (lines.length < rows)
        lines.push({ text: row, x: mark.at.x, y, maxWidth }); row = ''; y += font * 1.35; };
    for (const character of mark.text) {
        if (character === '\n')
            flush();
        else {
            row += character;
            if (Array.from(row).length >= columns)
                flush();
        }
        ;
        if (lines.length >= rows)
            break;
    }
    if (row && lines.length < rows)
        flush();
    return lines;
}
export function paintAnnotations(ctx: CanvasRenderingContext2D, draft: AnnotationDraft): void {
    const width = draft.capture.anchor.width, line = Math.max(2, width / 400), font = Math.max(14, width / 60);
    ctx.strokeStyle = ANNOTATION_COLOR;
    ctx.fillStyle = ANNOTATION_COLOR;
    ctx.lineWidth = line;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.font = `${font}px sans-serif`;
    ctx.textBaseline = 'top';
    for (const mark of draft.marks) {
        if (mark.kind === 'text') {
            for (const line of annotationTextLines(mark, width, draft.capture.anchor.height))
                ctx.fillText(line.text, line.x, line.y, line.maxWidth);
        }
        else if (mark.kind === 'element') {
            ctx.strokeRect(mark.rectangle.x, mark.rectangle.y, mark.rectangle.width, mark.rectangle.height);
        }
        else if (mark.kind === 'rectangle') {
            ctx.strokeRect(Math.min(mark.from.x, mark.to.x), Math.min(mark.from.y, mark.to.y), Math.abs(mark.to.x - mark.from.x), Math.abs(mark.to.y - mark.from.y));
        }
        else {
            const [x1, y1, x2, y2] = arrowHead(mark, width);
            ctx.beginPath();
            ctx.moveTo(mark.from.x, mark.from.y);
            ctx.lineTo(mark.to.x, mark.to.y);
            ctx.moveTo(x1, y1);
            ctx.lineTo(mark.to.x, mark.to.y);
            ctx.lineTo(x2, y2);
            ctx.stroke();
        }
    }
}
function decodeImage(src: string, signal: AbortSignal): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        signal.throwIfAborted();
        const image = new Image();
        const finish = (error?: Error) => { clearTimeout(timer); signal.removeEventListener('abort', abort); image.onload = null; image.onerror = null; if (error) {
            image.removeAttribute('src');
            reject(error);
        }
        else
            resolve(image); };
        const abort = () => finish(new AnnotationError('UNAVAILABLE', '批注导出已取消。'));
        const timer = setTimeout(() => finish(new AnnotationError('UNAVAILABLE', '画面解码超时，请重新获取预览。')), 15000);
        signal.addEventListener('abort', abort, { once: true });
        image.onload = () => finish();
        image.onerror = () => finish(new AnnotationError('INVALID_FRAME', '画面未能解码。'));
        image.src = src;
    });
}
export async function renderAnnotationImage(input: AnnotationDraft, signal: AbortSignal): Promise<AnnotationImage> {
    const draft = validateAnnotationDraft(input), a = draft.capture.anchor;
    signal.throwIfAborted();
    if (await sha256(decodeBase64(draft.capture.imageBase64)) !== a.imageSHA256)
        throw new AnnotationError('INVALID_FRAME', '原始画面校验失败。');
    signal.throwIfAborted();
    const image = await decodeImage('data:image/jpeg;base64,' + draft.capture.imageBase64, signal);
    const canvas = document.createElement('canvas');
    try {
        signal.throwIfAborted();
        if (image.naturalWidth !== a.width || image.naturalHeight !== a.height)
            throw new AnnotationError('INVALID_FRAME', '原始画面尺寸不一致。');
        canvas.width = a.width;
        canvas.height = a.height;
        const ctx = canvas.getContext('2d');
        if (!ctx)
            throw new AnnotationError('UNAVAILABLE', '当前界面不支持导出批注。');
        ctx.drawImage(image, 0, 0);
        paintAnnotations(ctx, draft);
        signal.throwIfAborted();
        const uri = canvas.toDataURL('image/png');
        if (!uri.startsWith('data:image/png;base64,'))
            throw new AnnotationError('UNAVAILABLE', '批注图片未能导出。');
        const data = uri.slice('data:image/png;base64,'.length), digest = await sha256(decodeBase64(data));
        signal.throwIfAborted();
        return Object.freeze({ mediaType: 'image/png', data, width: a.width, height: a.height, sha256: digest });
    }
    finally {
        canvas.width = 0;
        canvas.height = 0;
        image.removeAttribute('src');
    }
}
