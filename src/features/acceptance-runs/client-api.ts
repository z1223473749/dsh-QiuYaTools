import { object, digest, integer, uuid, enumeration } from './contract.ts';
import { RUN_ENDPOINT, parseHistory, parseRunView } from './model.ts';
import type { RunHistoryRow } from './model.ts';
import type { RunView } from './contract.ts';
export interface RunReadConnection {
    rpc: {
        call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<{
            ok: boolean;
            value?: unknown;
            error?: {
                message?: string;
            };
        }>;
    };
}
export interface RunEvidenceData {
    evidenceId: string;
    mediaType: 'image/jpeg' | 'image/png';
    sha256: string;
    bytes: number;
    width: number;
    height: number;
    base64: string;
}
export interface RunReadAPI {
    list(chat: string, signal: AbortSignal): Promise<RunHistoryRow[]>;
    get(chat: string, run: string, signal: AbortSignal): Promise<RunView>;
    evidence(chat: string, run: string, evidence: string, signal: AbortSignal): Promise<RunEvidenceData>;
    export(chat: string, run: string, signal: AbortSignal): Promise<unknown>;
}
export function createRunReadAPI(connection: () => RunReadConnection | undefined): RunReadAPI {
    async function call(op: string, chatSessionId: string, signal: AbortSignal, fields: Record<string, string> = {}) { signal.throwIfAborted(); const peer = connection(); if (!peer)
        throw Error('连接尚未就绪'); const response = await peer.rpc.call('/api', RUN_ENDPOINT, { op, chatSessionId, ...fields }, signal); signal.throwIfAborted(); if (!response.ok)
        throw Error('任务记录暂不可用，请刷新后重试。'); return response.value; }
    return { async list(chat, signal) { return parseHistory(await call('list', chat, signal)); }, async get(chat, run, signal) { const view = parseRunView(await call('get', chat, signal, { runId: uuid(run) })); if (view.record.binding.chatSessionId !== chat || view.record.runId !== run)
            throw Error('会话记录已变化'); return view; }, async evidence(chat, run, evidence, signal) { const v = object(await call('evidence', chat, signal, { runId: uuid(run), evidenceId: uuid(evidence) }), ['evidenceId', 'mediaType', 'sha256', 'bytes', 'width', 'height', 'base64']); if (v.evidenceId !== evidence || typeof v.base64 !== 'string' || v.base64.length > 28 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(v.base64))
            throw Error('证据暂不可用'); return { evidenceId: uuid(v.evidenceId), mediaType: enumeration(v.mediaType, ['image/jpeg', 'image/png']), sha256: digest(v.sha256), bytes: integer(v.bytes, 20 * 1024 * 1024, 1), width: integer(v.width, 16384, 1), height: integer(v.height, 16384, 1), base64: v.base64 }; }, async export(chat, run, signal) { return call('export', chat, signal, { runId: uuid(run) }); } };
}
/** A generation/Abort fence for public owner reads; it has no mutation/control method. */
export class RunReadLifetime {
    #generation = 0;
    #closed = false;
    #controllers = new Set<AbortController>();
    invalidate() { this.#generation++; for (const controller of this.#controllers)
        controller.abort(); this.#controllers.clear(); }
    dispose() { this.#closed = true; this.invalidate(); }
    async read<T>(work: (signal: AbortSignal) => Promise<T>, accept: (value: T) => void): Promise<void> { if (this.#closed)
        return; this.invalidate(); const generation = this.#generation, controller = new AbortController(); this.#controllers.add(controller); try {
        const value = await work(controller.signal);
        if (!this.#closed && !controller.signal.aborted && generation === this.#generation)
            accept(value);
    }
    catch (error) {
        if (!this.#closed && !controller.signal.aborted && generation === this.#generation)
            throw error;
    }
    finally {
        this.#controllers.delete(controller);
    } }
    get pending() { return this.#controllers.size; }
}
