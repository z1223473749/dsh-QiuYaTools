import type { SessionId } from '@deepseek-ai/dsh-session/types'

export interface HostAgentRegistry<Agent extends { readonly id: string } = { readonly id: string }> {
  get(id: SessionId): Agent | undefined
  /** Harness 0.2.1 runtime ownership API. */
  roots?(): readonly Agent[]
  /** Harness 0.2.2 retains only the flat live registry. */
  list?(): readonly Agent[]
}

/** Read trusted Host services only; an id alone never establishes authority. */
export function isLiveRootAgent(registry: HostAgentRegistry | undefined, agent: { readonly id: string } | undefined): boolean {
  if (!registry || !agent || registry.get(agent.id as SessionId) !== agent) return false
  if (typeof registry.roots === 'function') return registry.roots().includes(agent)
  if (typeof registry.list !== 'function' || !registry.list().includes(agent)) return false
  // 0.2.2 removed runtime parent ownership. Use the live Session's public
  // classification; parentSession is fork lineage and must not exclude forks.
  const session: unknown = Reflect.get(agent, 'session')
  if (!session || typeof session !== 'object') return false
  const header: unknown = Reflect.get(session, 'header')
  if (!header || typeof header !== 'object') return false
  return Reflect.get(header, 'id') === agent.id && Reflect.get(header, 'origin') === undefined
}

export function listHostAgents<Agent extends { readonly id: string }>(registry: HostAgentRegistry<Agent> | undefined): readonly Agent[] {
  if (typeof registry?.list === 'function') return registry.list()
  return typeof registry?.roots === 'function' ? registry.roots() : []
}
