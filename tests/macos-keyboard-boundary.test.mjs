import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile} from 'node:fs/promises'
import {keyboardFixtureSource} from '../scripts/test-macos-live-vision-keyboard.mjs'
import {keyboardBoundaryFixtureSource,keyboardBoundaryVerdict,KEYBOARD_BOUNDARY_MODES} from '../scripts/macos-keyboard-boundary-core.mjs'
const os={sessionExists:true,screenLocked:false,leftButtonDown:false,rightButtonDown:false,middleButtonDown:false,keysDown:[]},cleanup={passed:true,safeRetirement:true}
test('autonomous sibling mode observes real window events after original handling; quit uses the existing real app menu',async()=>{
 const original=await readFile(new URL('../src/native/macos/fixtures/LiveVisionFixture.swift',import.meta.url),'utf8'),source=keyboardBoundaryFixtureSource(keyboardFixtureSource(original))
 assert.deepEqual(KEYBOARD_BOUNDARY_MODES,['sibling-on-down','quit-on-down'])
 assert.match(source,/super\.sendEvent\(event\)\n        if event\.type == \.keyDown, boundaryRole == "A"/u)
 assert.match(source,/boundarySwitched = true; sibling\.makeKeyAndOrderFront\(nil\)/u)
 assert.match(source,/keyEquivalent: "q"/u);assert.match(source,/return event\n        \}/u)
 assert.doesNotMatch(source,/CGEvent\(|postToPid|keyboardSetUnicodeString|input\.stringValue\s*=(?!=)/u)
 assert.match(source,/"application-will-terminate"/u);assert.match(source,/"keyboard-boundary-terminal"/u)
 assert.throws(()=>keyboardBoundaryFixtureSource('changed fixture'),/marker changed/)
})
test('sibling boundary requires exactly one original Down, no B Down, one cleanup Up and real original-recipient post metadata',()=>{
 const evidence={finalBoundary:{switched:true,aDown:1,bDown:0,aUp:0,bUp:1,keyWindowId:200,bWindowId:200},action:{error:'FOCUS_CHANGED'},afterAction:{os,native:{focusAttempt:{ownedKeyUpPosts:1,ownedKeyReleaseStage:'posted-original'}}},release:{confirmed:true}}
 assert.equal(keyboardBoundaryVerdict({mode:'sibling-on-down',evidence,cleanup}).functionalPassed,true)
 for(const change of[{bDown:1},{aDown:2},{bUp:0},{keyWindowId:100}])assert.equal(keyboardBoundaryVerdict({mode:'sibling-on-down',evidence:{...evidence,finalBoundary:{...evidence.finalBoundary,...change}},cleanup}).functionalPassed,false)
 assert.equal(keyboardBoundaryVerdict({mode:'sibling-on-down',evidence:{...evidence,afterAction:{os,native:{focusAttempt:{ownedKeyUpPosts:0,ownedKeyReleaseStage:'retired-no-held-input'}}}},cleanup}).functionalPassed,false)
 assert.equal(keyboardBoundaryVerdict({mode:'sibling-on-down',evidence,cleanup:{passed:false}}).functionalPassed,false)
})
test('retired recipient green needs zero actual Up posts, a verified no-held retired release, natural old exit and a new input-free lease',()=>{
 const evidence={quitExit:{code:0,signal:null},originalRetired:true,finalBoundary:{quitDownSeen:true},afterAction:{os,native:{focusAttempt:{ownedKeyUpPosts:0,retiredOwnedKeyReleases:1,ownedKeyReleaseStage:'retired-no-held-input'}}},release:{confirmed:true},successor:{started:true,newLeaseConfirmed:true,noInputEvents:true}}
 assert.equal(keyboardBoundaryVerdict({mode:'quit-on-down',evidence,cleanup}).functionalPassed,true)
 for(const change of[{quitExit:{code:0,signal:'SIGTERM'}},{originalRetired:false},{release:{confirmed:false}},{successor:{started:true,newLeaseConfirmed:false,noInputEvents:true}},{successor:{started:true,newLeaseConfirmed:true,noInputEvents:false}}])assert.equal(keyboardBoundaryVerdict({mode:'quit-on-down',evidence:{...evidence,...change},cleanup}).functionalPassed,false)
 for(const focus of[{ownedKeyUpPosts:1,retiredOwnedKeyReleases:1,ownedKeyReleaseStage:'retired-no-held-input'},{ownedKeyUpPosts:0,retiredOwnedKeyReleases:0,ownedKeyReleaseStage:'retired-no-held-input'},{ownedKeyUpPosts:0,retiredOwnedKeyReleases:1,ownedKeyReleaseStage:'recipient-unverified'},{}])assert.equal(keyboardBoundaryVerdict({mode:'quit-on-down',evidence:{...evidence,afterAction:{os,native:{focusAttempt:focus}}},cleanup}).functionalPassed,false)
})
test('old strict birth guard retained-held/block is recorded as red, never counted as green or permitted to start successor',()=>{
 const evidence={quitExit:{code:0,signal:null},originalRetired:true,finalBoundary:{quitDownSeen:true},afterAction:{os,native:{focusAttempt:{}}},release:{confirmed:false,keysHeld:1,journalPresent:true},successor:{started:false,skippedReason:'original-release-unconfirmed'}}
 const red=keyboardBoundaryVerdict({mode:'quit-on-down',evidence,cleanup:{passed:false,safeRetirement:true},expected:'red'})
 assert.equal(red.status,'expected-red');assert.equal(red.functionalPassed,false);assert.equal(red.expectedBlockingRegressionConfirmed,true);assert.equal(red.comparisonAccepted,true);assert.equal(red.noGlobalZeroEventClaim,true)
 assert.equal(keyboardBoundaryVerdict({mode:'quit-on-down',evidence,cleanup,expected:'green'}).functionalPassed,false)
 for(const change of[{release:{confirmed:false,keysHeld:0,journalPresent:true}},{successor:{started:true}},{originalRetired:false},{afterAction:{os:{...os,keysDown:[12]}}}])assert.equal(keyboardBoundaryVerdict({mode:'quit-on-down',evidence:{...evidence,...change},cleanup,expected:'red'}).comparisonAccepted,false)
 assert.equal(keyboardBoundaryVerdict({mode:'quit-on-down',evidence,cleanup:{passed:false,safeRetirement:false},expected:'red'}).comparisonAccepted,false)
})
