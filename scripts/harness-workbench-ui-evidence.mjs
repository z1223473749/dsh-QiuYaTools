/** Test-only public DOM/current UI-response evidence. No control/observe requests are issued. */
import assert from'node:assert/strict';import{createHash}from'node:crypto';const sha=b=>createHash('sha256').update(b).digest('hex'),uuid=v=>typeof v==='string'&&/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/iu.test(v),text=(v,n=1024)=>typeof v==='string'&&v.length>0&&v.length<=n;
export function bindHarnessNativeApproval(status,expected,{now=Date.now()}={}){assert(text(expected.sessionId)&&text(expected.targetId)&&text(expected.appId)&&text(expected.appName));assert(Number.isSafeInteger(expected.targetPid)&&expected.targetPid>0);assert(Array.isArray(status.sessions)&&status.sessions.length===0,'No control session before owner permission');assert(Array.isArray(status.pending)&&status.pending.length<=32);const own=status.pending.filter(r=>r.sessionId===expected.sessionId);assert.equal(own.length,1,'Exactly one request of current chat');const r=own[0];assert(uuid(r.requestId)&&r.requestVersion===1&&r.state==='pending');assert.equal(status.pending.filter(v=>v.requestId===r.requestId).length,1,'Request ID cannot be ambiguous');assert.equal(r.appId,expected.appId,'Requested native app must match already pinned own target');assert.equal(r.appName,expected.appName);assert(Number.isFinite(r.createdAt)&&r.createdAt<=now&&Number.isFinite(r.expiresAt)&&r.expiresAt>now);return{requestId:r.requestId,requestVersion:r.requestVersion,sessionId:r.sessionId,appId:r.appId,appName:r.appName,targetId:expected.targetId,targetPid:expected.targetPid,state:r.state,createdAt:r.createdAt,expiresAt:r.expiresAt,controlSessionsBeforeOwner:0}}
export function projectWorkbenchPreview(request,body,expected){if(request?.method!=='qiuya-tools.workbench'||request?.payload?.op!=='preview'||request.payload.chatSessionId!==expected.sessionId)return null;const p=request.payload,v=body?.result?.value,t=v?.target,o=v?.observation;assert.equal(body.result.ok,true);assert(uuid(p.environmentId)&&uuid(p.workbenchTabId));assert(t?.chatSessionId===expected.sessionId&&t.environmentId===p.environmentId&&t.workbenchTabId===p.workbenchTabId&&t.kind==='desktop'&&t.targetId===expected.targetId&&t.appId===expected.appId);assert(Number.isSafeInteger(t.epoch)&&t.epoch>0);assert.equal(v.viewOnly,true,'Read-only small preview before any takeover');assert(o?.targetId===expected.targetId&&text(o.frameId,512)&&o.mediaType==='image/jpeg'&&text(o.imageBase64,32*1024*1024));assert(Number.isSafeInteger(o.width)&&o.width>1&&o.width<=16384&&Number.isSafeInteger(o.height)&&o.height>1&&o.height<=16384);assert(o.imageBase64.length%4===0&&/^[A-Za-z0-9+/]*={0,2}$/u.test(o.imageBase64));const bytes=Buffer.from(o.imageBase64,'base64');assert(bytes.length>=4&&bytes.readUInt16BE(0)===0xffd8);const g=o.geometry;assert(g&&['x','y','width','height','scale'].every(k=>Number.isFinite(g[k]))&&g.width>0&&g.height>0&&g.scale>0);return{sessionId:t.chatSessionId,environmentId:t.environmentId,workbenchTabId:t.workbenchTabId,targetId:t.targetId,appId:t.appId,epoch:t.epoch,frameId:o.frameId,width:o.width,height:o.height,geometry:{...g},viewOnly:true,imageSHA256:sha(bytes),imageBytes:bytes.length}}
export function matchWorkbenchPaint(paint,receipts,expected){assert(paint?.painted===true&&paint.chatSessionId===expected.sessionId&&paint.complete===true&&paint.connected===true);assert(paint.fit==='fill'&&paint.width>1&&paint.height>1&&paint.box.width>0&&paint.box.height>0);assert(Array.isArray(receipts)&&receipts.length<=64);const matches=receipts.filter(r=>r.sessionId===expected.sessionId&&r.targetId===expected.targetId&&r.appId===expected.appId&&r.viewOnly===true&&r.imageSHA256===paint.imageSHA256&&r.width===paint.width&&r.height===paint.height);if(!matches.length)return null;assert.equal(new Set(matches.map(r=>JSON.stringify([r.environmentId,r.workbenchTabId,r.epoch,r.geometry]))).size,1,'Identical image bytes cannot conceal different target epoch/geometry/view');return{...paint,targetId:expected.targetId,appId:expected.appId,environmentId:matches[0].environmentId,workbenchTabId:matches[0].workbenchTabId,epoch:matches[0].epoch,geometry:matches[0].geometry,matchingActualFrameIds:[...new Set(matches.map(r=>r.frameId))],frameIdentityScope:'Same actual target/view/epoch/geometry and displayed image bytes; UI does not expose a unique frameId. Listed IDs are real received frame candidates, never an invented displayed-frame ID.'}}
export function collectWorkbenchPreviewResponses(page,expected){const records=[],pending=new Set();let closed=false,accepted=0,failures=0;const origin=new URL(page.url()).origin;const response=async value=>{if(closed)return;try{const url=new URL(value.url());if(url.origin!==origin||url.pathname!=='/api/qiuya-tools.workbench'||value.request().method()!=='POST')return;const request=value.request().postDataJSON();if(request?.payload?.op!=='preview'||request.payload.chatSessionId!==expected.sessionId)return;if(pending.size>=32){failures++;return}const job=(async()=>{try{const r=projectWorkbenchPreview(request,await value.json(),expected);if(!closed&&r){records.push(r);accepted++;if(records.length>64)records.shift()}}catch{if(!closed)failures++}})();pending.add(job);job.finally(()=>pending.delete(job))}catch{if(!closed)failures++}};page.on('response',response);return{records,get summary(){return{accepted,failures,retained:records.length,deviceRequestsIssued:0,imagesRetained:0,requestArgumentsRetained:0}},dispose(){if(closed)return;closed=true;page.off('response',response);records.splice(0)}}}
/** Runs in the existing page, read-only. It decodes only the current own data URI. */
export async function captureWorkbenchPaint(image,{sessionId}){const before=image.currentSrc||image.src,owner=image.closest('[data-qyt-workbench-chat]');if(!image.isConnected||owner?.getAttribute('data-qyt-workbench-chat')!==sessionId||!image.complete||image.naturalWidth<=1||image.naturalHeight<=1)return null;if(!before.startsWith('data:image/jpeg;base64,'))return null;const encoded=before.slice('data:image/jpeg;base64,'.length);if(encoded.length>32*1024*1024)return null;const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0)),digest=await crypto.subtle.digest('SHA-256',bytes),after=image.currentSrc||image.src,box=image.getBoundingClientRect();if(before!==after||!image.isConnected)return null;return{painted:true,complete:image.complete,connected:image.isConnected,chatSessionId:sessionId,imageSHA256:[...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join(''),width:image.naturalWidth,height:image.naturalHeight,fit:getComputedStyle(image).objectFit,box:{x:box.x,y:box.y,width:box.width,height:box.height}}}

/** The official input overlay owns a zero-area marker; React portals its card to body.
 * The returned `anchor` is the portal, retained as the caller's card-search alias.
 * Gates are lazy Playwright selectors so the actual approval can mount after send. */
export function locateHarnessWorkbenchChat(page, sessionId) {
  assert(text(sessionId))
  const id = JSON.stringify(sessionId)
  const content = `[data-conversation-content][data-conversation-session=${id}]`
  const marker = `[data-qyt-workbench-anchor=${id}]`
  const portal = `.qyt-workbench-small-portal[data-qyt-workbench-chat=${id}]`
  const phase = ':is([data-phase="active"],[data-phase="settling"],[data-phase="hero"])'
  // A nested inactive panel cannot lend its marker or content to a visible parent.
  const owner = `${phase}:visible:has(${content}:visible):has(${marker})` +
    `:not(:has([data-phase] ${content})):not(:has([data-phase] ${marker}))` +
    `:not(:has([data-conversation-content][data-conversation-session]:not(${content})))` +
    `:not(:has([data-qyt-workbench-anchor]:not(${marker})))`
  const card = `body > ${portal} > :is(.qyt-workbench-approvals,.qyt-workbench-small):visible`
  const unique = selector => `:has(${selector}):not(:has(:nth-match(${selector},2)))`
  const gate = 'html' + [owner, `${content}:visible`, marker,
    `[data-qyt-workbench-chat=${id}]`, card].map(unique).join('')
  return { owner: page.locator(`${gate} ${owner}`), anchor: page.locator(`${gate} body > ${portal}`) }
}
/** Runs read-only in the real document; geometry comes from the browser itself.
 * No request, decision, synthetic event, or visibility override is issued here. */
export function captureHarnessWorkbenchScope(anchor, { sessionId }) {
  if (!anchor.isConnected || anchor.getAttribute('data-qyt-workbench-chat') !== sessionId) throw Error('WRONG_WORKBENCH_CHAT')
  const doc = anchor.ownerDocument, view = doc.defaultView
  const phases = new Set(['active', 'settling', 'hero'])
  const visible = node => {
    const box = node.getBoundingClientRect(), style = view.getComputedStyle(node)
    return node.isConnected && node.getClientRects().length > 0 && box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
  }
  const allContents = [...doc.querySelectorAll('[data-conversation-content][data-conversation-session]')]
  const contents = allContents.filter(node => node.getAttribute('data-conversation-session') === sessionId && visible(node))
  if (contents.length !== 1) throw Error('WRONG_VISIBLE_CONVERSATION_OWNER')
  const content = contents[0], owner = content.closest('[data-phase]')
  if (!owner || !phases.has(owner.getAttribute('data-phase')) || !visible(owner)) throw Error('VISIBLE_CONVERSATION_OWNER_MISSING')
  const ownedContents = allContents.filter(node => node.closest('[data-phase]') === owner)
  if (ownedContents.length !== 1 || ownedContents[0] !== content) throw Error('WRONG_VISIBLE_CONVERSATION_OWNER')
  const panels = [...doc.querySelectorAll('[data-phase]')].filter(node => phases.has(node.getAttribute('data-phase')) && visible(node) && allContents.some(item => item.closest('[data-phase]') === node && item.getAttribute('data-conversation-session') === sessionId && visible(item)))
  if (panels.length !== 1 || panels[0] !== owner) throw Error('WRONG_VISIBLE_CONVERSATION_OWNER')
  const allMarkers = [...doc.querySelectorAll('[data-qyt-workbench-anchor]')]
  const markers = allMarkers.filter(node => node.getAttribute('data-qyt-workbench-anchor') === sessionId)
  if (markers.length !== 1) throw Error('AMBIGUOUS_WORKBENCH_MARKER')
  const marker = markers[0]
  if (!marker.isConnected || marker.closest('[data-phase]') !== owner) throw Error('WRONG_WORKBENCH_MARKER_OWNER')
  const ownedMarkers = allMarkers.filter(node => node.closest('[data-phase]') === owner)
  if (ownedMarkers.length !== 1 || ownedMarkers[0] !== marker) throw Error('AMBIGUOUS_WORKBENCH_MARKER')
  const portals = [...doc.querySelectorAll('[data-qyt-workbench-chat]')].filter(node => node.getAttribute('data-qyt-workbench-chat') === sessionId)
  if (portals.length !== 1 || portals[0] !== anchor) throw Error('AMBIGUOUS_WORKBENCH_PORTAL')
  if (anchor.parentElement !== doc.body || !anchor.classList.contains('qyt-workbench-small-portal')) throw Error('WRONG_WORKBENCH_PORTAL_OWNER')
  const cards = [...anchor.children].filter(node => node.matches('.qyt-workbench-approvals,.qyt-workbench-small') && visible(node))
  if (cards.length !== 1) throw Error('VISIBLE_WORKBENCH_CARD_MISSING_OR_AMBIGUOUS')
  const box = anchor.getBoundingClientRect(), markerBox = marker.getBoundingClientRect(), ownerBox = owner.getBoundingClientRect(), cardBox = cards[0].getBoundingClientRect()
  return {
    chatSessionId: sessionId, phase: owner.getAttribute('data-phase'), ownership: 'input-overlay-body-portal',
    uniqueOwnPanel: true, uniqueOwnContent: true, uniqueOwnAnchor: true, uniqueOwnPortal: true,
    contentChatSessionId: content.getAttribute('data-conversation-session'), markerChatSessionId: marker.getAttribute('data-qyt-workbench-anchor'), portalChatSessionId: anchor.getAttribute('data-qyt-workbench-chat'),
    markerConnected: marker.isConnected, portalConnected: anchor.isConnected, markerNearestPhaseMatchesOwner: true,
    markerAttribute: 'data-qyt-workbench-anchor', portalAttribute: 'data-qyt-workbench-chat', portalParent: 'body',
    anchorRole: 'body-portal-card-search-alias', anchorAreaRequired: false, portalAreaRequired: false,
    anchorBox: { width: box.width, height: box.height }, markerBox: { width: markerBox.width, height: markerBox.height },
    ownerBox: { x: ownerBox.x, y: ownerBox.y, width: ownerBox.width, height: ownerBox.height },
    cardKind: cards[0].classList.contains('qyt-workbench-small') ? 'preview' : 'approval',
    cardBox: { x: cardBox.x, y: cardBox.y, width: cardBox.width, height: cardBox.height },
  }
}

/** Own authored fixture only. A trusted DOM update precedes the original screenshot; background RAF is not a capture prerequisite. */
export function fixtureMovePaintURL(url,nonce,role){assert.match(nonce,/^[a-f0-9]{32}$/u);assert(['A','B'].includes(role));const u=new URL(url);assert.equal(u.protocol,'http:');assert.equal(u.hostname,'127.0.0.1');assert(u.port);assert.equal(u.username,'');assert.equal(u.password,'');assert.equal(u.search,'');assert.equal(u.hash,'');assert.equal(u.pathname,'/'+nonce+'/'+role+'/A/');return new URL('paint-state',u).href}
export function admitMovePaintState(value,{nonce,role}){assert.deepEqual(Object.keys(value).sort(),['nonce','observedSequence','paintedSequence','role','tab']);assert.equal(value.nonce,nonce);assert.equal(value.role,role);assert.equal(value.tab,'A');for(const k of ['observedSequence','paintedSequence'])assert(Number.isSafeInteger(value[k])&&value[k]>=0&&value[k]<=64);assert(value.paintedSequence<=value.observedSequence);return Object.freeze({...value})}
export async function readMovePaintState(url,scope,{deadline,signal,fetcher=fetch}={}){signal?.throwIfAborted();const left=deadline-Date.now();assert(left>0,'H2_FIXED_PAINT_DEADLINE');const controller=new AbortController(),cancel=()=>controller.abort(signal?.reason);signal?.addEventListener('abort',cancel,{once:true});const timer=setTimeout(()=>controller.abort(Error('H2_FIXED_PAINT_DEADLINE')),left);try{const response=await fetcher(url,{signal:controller.signal,redirect:'error',cache:'no-store'});assert.equal(response.status,200);const reader=response.body.getReader(),pieces=[];let size=0;try{while(true){signal?.throwIfAborted();assert(Date.now()<deadline,'H2_FIXED_PAINT_DEADLINE');const{done,value}=await reader.read();if(done)break;size+=value.byteLength;assert(size<=1024,'H2_PAINT_BODY_BOUND');pieces.push(value)}}finally{reader.releaseLock()}signal?.throwIfAborted();assert(Date.now()<deadline,'H2_FIXED_PAINT_DEADLINE');return admitMovePaintState(JSON.parse(Buffer.concat(pieces).toString('utf8')),scope)}finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel)}}
export async function waitMovedDOM(url,scope,baseline,options){assert(Number.isSafeInteger(baseline)&&baseline>=0&&baseline<=64);while(true){const value=await readMovePaintState(url,scope,options);if(value.observedSequence>baseline)return value;const left=options.deadline-Date.now();assert(left>0,'H2_FIXED_PAINT_DEADLINE');await new Promise((yes,no)=>{const cleanup=()=>options.signal?.removeEventListener('abort',onAbort),timer=setTimeout(()=>{cleanup();yes()},Math.min(25,left)),onAbort=()=>{clearTimeout(timer);cleanup();no(options.signal.reason??Error('H2_PAINT_ABORTED'))};options.signal?.addEventListener('abort',onAbort,{once:true});if(options.signal?.aborted)onAbort()})}}

/** Read only the exact current editor node; a stale child panel must not stand in for its parent. */
export function staleStyleSurfaceFacts(root) {
  const panels = root?.matches?.('section.qyt-ann[aria-label="画面批注"]') ? [root] : [...(root?.querySelectorAll?.('section.qyt-ann[aria-label="画面批注"]') ?? [])];
  if (panels.length !== 1) return { refused: false, reason: 'missing-or-ambiguous-own-parent' };
  const parent = panels[0], alerts = [...parent.querySelectorAll('[role="alert"]')].map(e => e.textContent.trim()), buttons = [...parent.querySelectorAll('button')];
  return { refused: alerts.includes('画面或当前聊天已变化，请关闭批注后重新打开。') && !parent.querySelector('[aria-label="临时样式反馈"]') && !buttons.some(e => e.textContent.trim() === '加入本次批注') && buttons.filter(e => e.textContent.trim() === '关闭').length === 1, reason: 'current-parent-stale', alerts, stylePanelPresent: !!parent.querySelector('[aria-label="临时样式反馈"]'), addButtons: buttons.filter(e => e.textContent.trim() === '加入本次批注').length };
}
