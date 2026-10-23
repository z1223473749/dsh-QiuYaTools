import type { ResourceProvider } from '@deepseek-ai/dsh-client-resources/client';
import type { RunView } from './contract.ts';
import type { RemoteFailure } from '@deepseek-ai/dsh-typert-protocol';
/** Public cross-realm RemoteFailure shape, without requiring a Host-only runtime module. */
const readFailure = (code: 'gateway/bad-request' | 'gateway/internal', message: string): RemoteFailure => Object.assign(new Error(message), { code, details: {}, isDSHRemoteError: true as const });
import type { RunReadAPI } from './client-api.ts';
import { parseRunAddress } from './model.ts';
import type { RunHistoryRow } from './model.ts';
export type RunResource = {
    kind: 'history';
    chatSessionId: string;
    rows: RunHistoryRow[];
} | {
    kind: 'detail';
    chatSessionId: string;
    view: RunView;
};
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface ResourceProtocolMap {
        'qiuya-run': RunResource;
    }
}
/** Apply-owned invalidation only; never resumes a run or dispatches input. */
export class RunReadRefreshBus {
    #lifetime = new AbortController();
    #versions = new Map<string, number>();
    #listeners = new Map<string, Set<() => void>>();
    #closed = false;
    version(address: string) { return this.#versions.get(address) ?? 0; }
    refresh(address: string) { if (this.#closed)
        return; this.#versions.set(address, this.version(address) + 1); for (const notify of this.#listeners.get(address) ?? [])
        notify(); }
    wait(address: string, after: number, signal: AbortSignal): Promise<void> { if (this.#closed || signal.aborted || this.version(address) !== after)
        return Promise.resolve(); return new Promise(resolve => { const listeners = this.#listeners.get(address) ?? new Set<() => void>(); this.#listeners.set(address, listeners); const done = () => { listeners.delete(done); if (listeners.size === 0)
        this.#listeners.delete(address); signal.removeEventListener('abort', done); resolve(); }; listeners.add(done); signal.addEventListener('abort', done, { once: true }); if (this.#closed || signal.aborted || this.version(address) !== after)
        done(); }); }
    dispose() { this.#closed = true; this.#lifetime.abort(); for (const listeners of this.#listeners.values())
        for (const done of [...listeners])
            done(); this.#listeners.clear(); this.#versions.clear(); }
    get pending() { let n = 0; for (const listeners of this.#listeners.values())
        n += listeners.size; return n; }
    get closed() { return this.#closed; }
    get signal() { return this.#lifetime.signal; }
}
export function createRunResourceProvider(api: RunReadAPI, bus: RunReadRefreshBus, isCurrent: (chat: string) => boolean): ResourceProvider<'qiuya-run'> {
    return { protocol: 'qiuya-run', async *open(address, { signal: ownerSignal }) {
            const signal = AbortSignal.any([ownerSignal, bus.signal]);
            const target = parseRunAddress(address);
            if (!target) {
                yield { ok: false, error: readFailure('gateway/bad-request', '任务记录地址无效。') };
                return;
            }
            while (!signal.aborted && !bus.closed) {
                const version = bus.version(address);
                try {
                    if (!isCurrent(target.chatSessionId))
                        throw Error('Session changed');
                    const value: RunResource = target.runId ? { kind: 'detail', chatSessionId: target.chatSessionId, view: await api.get(target.chatSessionId, target.runId, signal) } : { kind: 'history', chatSessionId: target.chatSessionId, rows: await api.list(target.chatSessionId, signal) };
                    if (signal.aborted || bus.closed)
                        return;
                    if (!isCurrent(target.chatSessionId))
                        throw Error('Session changed');
                    yield { ok: true, value };
                }
                catch {
                    if (signal.aborted || bus.closed)
                        return;
                    yield { ok: false, error: readFailure('gateway/internal', '任务记录暂不可用，请刷新后重试。') };
                }
                await bus.wait(address, version, signal);
            }
        } };
}
