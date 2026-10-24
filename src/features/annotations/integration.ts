import type { Context } from '@deepseek-ai/cordis';
import { AnnotationError } from './contract.ts';
import type { AnnotationSource } from './source-contract.ts';
import { installAnnotationHost } from './host.ts';
import type { AnnotationHostOptions } from './host.ts';
/** The source is a real read-only workbench dependency, never a model-supplied verifier. */
export async function installAnnotations(ctx: Context, options: {
    source: AnnotationSource;
    resolveOwnerScope: AnnotationHostOptions['resolveScope'];
    enabled(): boolean;
}): Promise<{
    dispose(): Promise<void>;
}> {
    let disposed = false, disposing: Promise<void> | undefined;
    const lifecycle = new AbortController();
    let unregister: (() => Promise<void>) | undefined;
    try {
        unregister = installAnnotationHost(ctx, { source: options.source, async resolveScope(chat, signal) {
                const current = AbortSignal.any([signal, lifecycle.signal]);
                const guard = () => { current.throwIfAborted(); if (disposed || !options.enabled())
                    throw new AnnotationError('UNAVAILABLE', '电脑操控尚未启用。'); };
                guard();
                const scope = await options.resolveOwnerScope(chat, current);
                guard();
                scope.assertCurrent();
                return { chatSessionId: scope.chatSessionId, signal: AbortSignal.any([current, scope.signal]), assertCurrent() { guard(); scope.assertCurrent(); } };
            } });
    }
    catch (failure) {
        disposed = true;
        lifecycle.abort();
        const errors: unknown[] = [failure];
        try {
            await options.source.dispose();
        }
        catch (error) {
            errors.push(error);
        }
        ;
        throw new AggregateError(errors, '画面批注初始化未完成。');
    }
    return { dispose() { if (disposing)
            return disposing; disposed = true; lifecycle.abort(); disposing = (async () => { const results = await Promise.allSettled([Promise.resolve().then(() => unregister?.()), Promise.resolve().then(() => options.source.dispose())]); const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected'); if (failures.length)
            throw new AggregateError(failures.map(result => result.reason), '画面批注清理尚未确认。'); })(); return disposing; } };
}
