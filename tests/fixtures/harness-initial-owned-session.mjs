/** Test setup: reuse only the explicitly selected own workspace's first blank.
 * Later New Session transitions continue to require a fresh public identity. */
import assert from 'node:assert/strict'
import {selectedHarnessWorkspaceSession} from './harness-workspace-prerequisite.mjs'
export async function waitFirstOwnedHarnessBlank(read,workspace,expectedSessionId,{now=Date.now,sleep=ms=>new Promise(done=>setTimeout(done,ms)),budgetMs=15000}={}){
 assert(Number.isFinite(budgetMs)&&budgetMs>0&&budgetMs<=15000);assert.equal(typeof expectedSessionId,'string')
 const deadline=now()+budgetMs;let candidate,since=now()
 while(now()<deadline){
  const snapshot=await read(),visible=snapshot.conversations.filter(c=>c.visible),selected=snapshot.rows.filter(r=>r.visible&&r.key?.startsWith('session:')&&r.selected==='true')
  const next=selectedHarnessWorkspaceSession(snapshot,workspace)
  const exact=next===expectedSessionId&&visible.length===1&&visible[0].sessionId===expectedSessionId&&selected.length===1&&selected[0].key==='session:'+expectedSessionId&&visible[0].composers.filter(c=>c.visible&&c.editable==='true').length===1
  const value=exact?next:undefined
  if(value!==candidate){candidate=value;since=now()}
  if(now()>=deadline)break
  if(candidate&&now()-since>=750)return candidate
  await sleep(Math.min(100,Math.max(0,deadline-now())))
 }
 throw Error('The explicitly selected first own workspace blank did not settle inside original15000ms; no input sent')
}
export function committedOwnSessionReady(snapshot,sessionId){
 if(!sessionId||!snapshot||!Array.isArray(snapshot.conversations)||!Array.isArray(snapshot.rows))return false
 const visible=snapshot.conversations.filter(item=>item.visible),selected=snapshot.rows.filter(row=>row.visible&&row.key?.startsWith('session:')&&row.selected==='true')
 return visible.length===1&&visible[0].sessionId===sessionId&&visible[0].phase!=='hero'&&selected.length===1&&selected[0].key==='session:'+sessionId&&selected[0].draggable===true&&visible[0].composers.filter(input=>input.visible&&input.editable==='true').length===1
}
/** Explicit plan-test setup after its own archive test deselects the active chat.
 * Select exactly the independently preserved own Session once; never send a draft or retry input. */
export async function restorePreservedOwnSession(read,select,workspace,sessionId,committedIds,{now=Date.now,sleep=ms=>new Promise(done=>setTimeout(done,ms)),budgetMs=15000}={}){
 assert(Number.isFinite(budgetMs)&&budgetMs>0&&budgetMs<=15000);assert(committedIds.has(sessionId),'Restore requires a known committed own Session')
 const deadline=now()+budgetMs,before=await read();if(committedOwnSessionReady(before,sessionId))return before
 const visible=before.conversations.filter(c=>c.visible),selected=before.rows.filter(r=>r.visible&&r.selected==='true'&&r.key?.startsWith('session:'))
 assert(visible.length===1&&visible[0].sessionId===null&&visible[0].phase==='hero'&&visible[0].composers.length===1&&visible[0].composers[0].editable==='false'&&visible[0].composers[0].textLength===0&&selected.length===0,'Restore only the actual inert unselected post-archive hero')
 assert(before.rows.some(r=>r.visible&&r.key==='workspace:'+workspace.workspaceId)&&before.rows.filter(r=>r.visible&&r.key==='session:'+sessionId&&r.draggable===true).length===1,'Preserved own committed row/workspace must be unique and visible')
 assert(now()<deadline,'Original blank-session budget expired before own restore');await select(sessionId,Math.max(1,deadline-now()))
 while(now()<deadline){const snapshot=await read();if(now()>=deadline)break;if(committedOwnSessionReady(snapshot,sessionId))return snapshot;await sleep(Math.min(100,deadline-now()))}
 throw Error('Explicit preserved own Session selection did not settle within remaining original blank-session budget; no input replay')
}
/** First-use setup only: SDK may replace an uncommitted own workspace hero
 * before input. Adopt only the current uniquely selected empty hero after its
 * own continuous750ms proof, inside the original shared15s. Never used after a
 * prompt/commit or in response to a New Session click. */
export async function waitCurrentOwnedHarnessBlank(read,workspace,{now=Date.now,sleep=ms=>new Promise(done=>setTimeout(done,ms)),budgetMs=15000,onSample=()=>{}}={}){
 assert(Number.isFinite(budgetMs)&&budgetMs>0&&budgetMs<=15000)
 const deadline=now()+budgetMs;let candidate,since=now()
 while(now()<deadline){
  const snapshot=await read(),visible=snapshot.conversations.filter(c=>c.visible),selected=snapshot.rows.filter(r=>r.visible&&r.key?.startsWith('session:')&&r.selected==='true'),chips=snapshot.workspaceChips.filter(c=>c.visible)
  const next=selectedHarnessWorkspaceSession(snapshot,workspace),hero=visible[0],composers=hero?.composers.filter(c=>c.visible)??[]
  const exact=next&&visible.length===1&&hero.phase==='hero'&&hero.sessionId===next&&selected.length===1&&selected[0].key==='session:'+next&&selected[0].draggable===false&&composers.length===1&&composers[0].editable==='true'&&composers[0].phase==='plain'&&composers[0].textLength===0&&chips.length===1&&chips[0].text===workspace.title&&snapshot.rows.filter(r=>r.visible&&r.key==='workspace:'+workspace.workspaceId).length===1
  const value=exact?next:undefined;if(value!==candidate){candidate=value;since=now()}
  onSample({at:now(),candidate:candidate??null,stableMs:candidate?now()-since:0})
  if(now()>=deadline)break
  if(candidate&&now()-since>=750)return candidate
  await sleep(Math.min(100,Math.max(0,deadline-now())))
 }
 throw Error('The current first own uncommitted hero did not settle within original15000ms; no New Session or input sent')
}
