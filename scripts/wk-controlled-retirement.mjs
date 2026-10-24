/** Test carrier only. Never swallows active/unknown HTTP failures or input. */
import assert from 'node:assert/strict'
import { macProcessCheckPassed } from './computer-wkwebview-soak-evidence.mjs'
const identityKey=x=>x&&`${x.pid}:${x.birthMicros}:${x.uniqueId}:${x.path}`
const valid=x=>x&&Number.isSafeInteger(x.pid)&&x.pid>0&&typeof x.birthMicros==='string'&&/^[1-9][0-9]*$/u.test(x.birthMicros)&&typeof x.uniqueId==='string'&&/^[1-9][0-9]*$/u.test(x.uniqueId)&&typeof x.path==='string'&&x.path.startsWith('/')
export class WKControlledRetirement {
  constructor({ reportPath, nonce, clock=()=>performance.now() }) { assert.match(reportPath,/^\/__wk_soak\/[a-f0-9-]{36}\/frames$/u);assert.match(nonce,/^[a-f0-9-]{36}$/u);this.path=reportPath;this.nonce=nonce;this.clock=clock;this.serial=0;this.retirements=new Map();this.tokens=new WeakSet();this.records=[];this.pending=new Set() }
  request({method,path,host,origin,generationHeader,nonceHeader,contentLength,expectedOrigin,generation,native}) {
    if(method!=='POST'||path!==this.path||origin!==expectedOrigin||host!==new URL(expectedOrigin).host||nonceHeader!==this.nonce||generationHeader!==String(generation)||!Number.isSafeInteger(generation)||generation<1||!valid(native)||!Number.isSafeInteger(contentLength)||contentLength<1||contentLength>256000)return null
    const token=Object.freeze({id:++this.serial,generation,nativeKey:identityKey(native),atMs:this.clock()});this.tokens.add(token);return token
  }
  begin(generation,native) { assert(Number.isSafeInteger(generation)&&generation>0&&valid(native));assert(!this.retirements.has(generation),'A generation cannot be retired twice');const r={generation,native:structuredClone(native),beganMs:this.clock(),issued:false,proven:false,closed:false};this.retirements.set(generation,r);return r }
  issued(generation) {const r=this.retirements.get(generation);assert(r&&!r.issued);r.issued=true}
  aborted(token,error,{aborted,complete}) {
    const r=token&&this.retirements.get(token.generation),now=this.clock()
    if(!token||!this.tokens.has(token)||!r||!r.issued||r.closed||token.nativeKey!==identityKey(r.native)||token.atMs>r.beganMs||now<r.beganMs||now-r.beganMs>10000||error?.code!=='ECONNRESET'||error?.message!=='aborted'||aborted!==true||complete!==false||this.pending.has(token)||this.records.some(x=>x.requestId===token.id||x.generation===token.generation)||this.pending.size>=5)return false
    if(r.proven)this.record(token,r);else this.pending.add(token);return true
  }
  confirm(generation,check) {const r=this.retirements.get(generation);assert(r?.issued&&!r.proven);assert(macProcessCheckPassed(check,[r.native]),'Exact controlled native retirement must be proven');r.proven=true;for(const t of this.pending)if(t.generation===generation){this.record(t,r);this.pending.delete(t)}assert(this.records.length<=5,'At most one reporter request per original controlled fault')}
  record(t,r){this.records.push({requestId:t.id,generation:t.generation,native:{pid:r.native.pid,birthMicros:r.native.birthMicros,uniqueId:r.native.uniqueId},reason:'pre-registered-own-clock-request-aborted-after-controlled-termination',exactNativeRetirementProven:true});assert(this.records.length<=5)}
  close(generation){const r=this.retirements.get(generation);assert(r?.proven&&!r.closed);r.closed=true}
  assertComplete() {assert.equal(this.pending.size,0,'Unproven retired notification remains');for(const r of this.retirements.values())assert(r.proven,'Controlled native retirement unproven')}
  snapshot(){return{plannedRetiredNotificationAborts:this.records.length,pendingUnproven:this.pending.size,records:structuredClone(this.records)}}
}
/** Clearing a dead-view getter requires every exact original member gone. Known ledger stays intact. */
export function retiredWKAssociation(association,known,check) {
  if(!association?.receiver?.native||!valid(association.receiver.native)||!Array.isArray(association.receiver.latest)||association.receiver.latest.length!==3)return false
  const identities=[association.receiver.native,...association.receiver.latest.map(x=>x.process)]
  if(identities.some(x=>!valid(x)||!known.some(k=>identityKey(k)===identityKey(x)))||new Set(identities.map(identityKey)).size!==4)return false
  return macProcessCheckPassed(check,identities)
}
