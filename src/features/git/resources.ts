import type { ResourceProvider } from '@deepseek-ai/dsh-client-resources/client'
import type { RemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import { parseGitAddress } from './contract.ts'

/** Resource navigation stores only an exact session and optional file; Git state stays in the shared store. */
export interface GitResource { sessionId: string; path?: string }
declare module '@deepseek-ai/dsh-client-ui-slots' { interface ResourceProtocolMap { 'qiuya-git': GitResource } }
const failure = (): RemoteFailure => Object.assign(new Error('Git 对比地址无效。'), { code: 'gateway/bad-request' as const, details: {}, isDSHRemoteError: true as const })
export function createGitResourceProvider(): ResourceProvider<'qiuya-git'> {
  return { protocol: 'qiuya-git', async *open(address, { signal }) { if (signal.aborted) return; const target = parseGitAddress(address); if (!target) { yield { ok: false, error: failure() }; return } yield { ok: true, value: target } } }
}
