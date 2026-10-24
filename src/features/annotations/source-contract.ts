/** Owner-only Host source contract. It carries no input/control capability and is never a model tool. */
import type { AnnotationAnchor, AnnotationCapture, AnnotationPoint } from './contract.ts';
export const ANNOTATION_ENDPOINT = 'qiuya-tools.annotations';
export interface AnnotationSourceScope {
    readonly chatSessionId: string;
    /** Stable Host capability for the exact connection/peer/principal. Never supplied by a DTO. */
    readonly ownerKey: object;
    readonly signal: AbortSignal;
    assertCurrent(): void;
}
export interface AnnotationSourceTarget {
    readonly chatSessionId: string;
    readonly environmentId: string;
    readonly workbenchTabId: string;
    readonly targetId: string;
    readonly appId: string;
    readonly kind: 'browser' | 'desktop';
    readonly epoch: number;
}
export interface AnnotationSourceCapture {
    readonly captureId: string;
    readonly capture: AnnotationCapture;
    readonly expiresAt: number;
    readonly elementHitTest: boolean;
}
export interface AnnotationFrameVerification {
    /** Actual newly observed frame identity; it must never be presented as the original captured frame. */
    readonly frameId: string;
    readonly imageSHA256: string;
    /** Opaque Host digest of document/navigation/scroll/viewport identity; no raw URL is needed. */
    readonly viewportVersion: string;
}
export type AnnotationInvalidReason = 'navigation' | 'scroll' | 'geometry' | 'pixels' | 'epoch' | 'expired' | 'element' | 'unavailable';
export type AnnotationSourceCheck = {
    readonly captureId: string;
    readonly valid: true;
    readonly anchor: AnnotationAnchor;
    readonly checkedAgainst: AnnotationFrameVerification;
} | {
    readonly captureId: string;
    readonly valid: false;
    readonly reason: AnnotationInvalidReason;
    readonly checkedAgainst?: AnnotationFrameVerification;
};
export interface AnnotationElementSelection {
    readonly captureId: string;
    readonly elementId: string;
    readonly viewportVersion: string;
    readonly role: string;
    readonly name: string;
    /** Clipped rectangle in original image pixels. No device coordinates or live backendNodeId are exposed. */
    readonly rectangle: Readonly<{
        x: number;
        y: number;
        width: number;
        height: number;
    }>;
}
export interface AnnotationSource {
    capture(scope: AnnotationSourceScope, target: AnnotationSourceTarget): Promise<AnnotationSourceCapture>;
    /** Reobserve read-only. Pixel-equivalent new frame ids may verify the old immutable image; navigation/scroll cannot. */
    check(scope: AnnotationSourceScope, captureId: string, elementIds: readonly string[]): Promise<AnnotationSourceCheck>;
    hitTest(scope: AnnotationSourceScope, captureId: string, point: AnnotationPoint): Promise<AnnotationElementSelection>;
    release(scope: AnnotationSourceScope, captureId: string): Promise<void>;
    dispose(): void | Promise<void>;
}
