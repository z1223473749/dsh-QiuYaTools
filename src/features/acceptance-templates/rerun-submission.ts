import type { SessionBinding, SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client';
import { text, uuid } from '../acceptance-runs/contract.ts';
export type RerunReceipt = 'delivered' | 'rejected' | 'unknown';
export interface RerunInput {
    templateId: string;
    versionId: string;
    versionLabel: string;
}
export function templateRerunPrompt(input: RerunInput, nonce: string) { return ['请在当前会话使用下列验收模板版本创建一份新的自动验收清单，并完成验收。', '模板编号：' + uuid(input.templateId), '清单版本编号：' + uuid(input.versionId), '本次被测版本：' + text(input.versionLabel, 120), '提交编号：' + uuid(nonce), '请先读取模板，再调用 qiuya_acceptance_from_template；创建清单后重新观察真实的当前目标，并核对当前应用或网站权限。已有效的始终允许可以继续使用。每次使用新的workflow/run/证据，不重放旧输入，不沿用旧通过结论；结果由独立验证决定。'].join('\n'); }
function durable(entry: SessionEventLikeEntry, value: string, cutoff: number) { return entry.type === 'event' && entry.event.type === 'user/message' && entry.event.seq > cutoff && entry.event.data.source.kind === 'user' && entry.event.data.content.filter(p => p.type === 'text').map(p => p.text).join('\n') === value; }
/** One explicit user request, one public prompt. A lost ACK never resends or claims a run started. */
export class TemplateRerunSubmission {
    private issued = false;
    private receipt?: { chat: string; binding: SessionBinding; session: SessionBinding['session']; text: string; cutoff: number };
    /** Readonly late confirmation. It never resends or turns delivery into an execution verdict. */
    isDurablyDelivered(): boolean {
        const value = this.receipt;
        return !!value && this.options.currentChat() === value.chat && this.options.binding(value.chat) === value.binding && value.binding.session === value.session && value.binding.eventSource.getSnapshot().entries.some(entry => durable(entry, value.text, value.cutoff));
    }
    constructor(private readonly options: {
        currentChat(): string | undefined;
        binding(chat: string): SessionBinding | undefined;
        signal: AbortSignal;
        timeoutMs?: number;
    }) { }
    async submit(chat: string, input: RerunInput): Promise<RerunReceipt> {
        if (this.issued)
            throw Error('本次提交已发出，请查看当前会话，勿重复发送。');
        const binding = this.options.binding(chat), session = binding?.session, signal = AbortSignal.any([this.options.signal, AbortSignal.timeout(Math.max(1, Math.min(this.options.timeoutMs ?? 15000, 15000)))]);
        const guard = () => { signal.throwIfAborted(); if (!binding || !session || this.options.currentChat() !== chat || this.options.binding(chat) !== binding || binding.session !== session)
            throw Error('会话已变化'); };
        guard();
        const value = templateRerunPrompt(input, crypto.randomUUID()), cutoff = binding!.eventSource.getSnapshot().entries.reduce((n, e) => e.type === 'event' ? Math.max(n, e.event.seq) : n, -1);
        let delivered = false, handle: ReturnType<SessionBinding['session']['beginSubmission']> | undefined, called = false, remove = () => { };
        let complete: (receipt: RerunReceipt) => void = () => { };
        const done = new Promise<RerunReceipt>(resolve => { complete = resolve; });
        const inspect = () => { try {
            guard();
            if (binding!.eventSource.getSnapshot().entries.some(entry => durable(entry, value, cutoff))) {
                delivered = true;
                complete('delivered');
            }
        }
        catch {
            complete(delivered ? 'delivered' : 'unknown');
        } };
        const aborted = () => complete(delivered ? 'delivered' : 'unknown');
        signal.addEventListener('abort', aborted, { once: true });
        try {
            remove = binding!.eventSource.subscribe(inspect);
            guard();
            handle = session!.beginSubmission({ mode: 'queue', text: value, attachments: [] });
            guard();
            this.issued = true;
            this.receipt = { chat, binding: binding!, session: session!, text: value, cutoff };
            called = true;
            // Do not wait for a hung admission before listening for durable receipt/abort. Rejections are handled once.
            void session!.prompt([{ type: 'text', text: value }], 'queue', signal, handle.requestId).then(result => { try {
                guard();
                inspect();
                if (!result.ok && !delivered)
                    complete('rejected');
            }
            catch {
                complete(delivered ? 'delivered' : 'unknown');
            } }, () => { inspect(); complete(delivered ? 'delivered' : 'unknown'); });
            inspect();
            return await done;
        }
        catch (error) {
            if (!called) {
                handle?.abandon();
                throw error;
            }
            return delivered ? 'delivered' : 'unknown';
        }
        finally {
            signal.removeEventListener('abort', aborted);
            remove();
        }
    }
}
