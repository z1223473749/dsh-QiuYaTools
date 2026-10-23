import { defineStore } from '@deepseek-ai/dsh-client-store';
import type { RunState } from './contract.ts';
/** Created only during apply. UI preferences contain no execution facts or persisted authority. */
export function createRunUIStore() { return defineStore({ init: () => ({ filter: 'all' as RunState | 'all', expanded: {} as Record<string, boolean> }), actions: { setFilter(state, value: RunState | 'all') { state.filter = value; }, expand(state, key: string, value: boolean) { state.expanded[key] = value; } } }); }
