import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile} from 'node:fs/promises'
import {keyboardFixtureSource,keyboardActions,keyboardVerdict} from '../scripts/test-macos-live-vision-keyboard.mjs'
test('keyboard fixture adapts only read-only snapshot geometry/counts and retains the real NSTextField and independent submit oracle',async()=>{
 const source=await readFile(new URL('../src/native/macos/fixtures/LiveVisionFixture.swift',import.meta.url),'utf8'),adapted=keyboardFixtureSource(source)
 assert.match(adapted,/input = NSTextField\(string: ""\)/u);assert.match(adapted,/input\.action = #selector\(submit\)/u);assert.match(adapted,/passed = visionNoteMatches\(input\.stringValue, note\)/u)
 assert.match(adapted,/input\.convert\(NSPoint\(x: input\.bounds\.midX, y: input\.bounds\.midY\), to: nil\)/u);assert.match(adapted,/"inputUTF16Length": self\.input\.stringValue\.utf16\.count/u)
 assert.doesNotMatch(adapted,/input\.stringValue\s*=(?!=)/u);assert.throws(()=>keyboardFixtureSource(source.replace('    @objc func submit()','    @objc  func submit()')),/marker changed/u)
})
test('one deterministic keyboard sequence has exactly one click, one full synthetic Chinese type and one Enter; foreign text/point rejected',()=>{
 const actions=keyboardActions('青山路18号，请轻放，核验码ABC123',{x:80,y:120})
 assert.deepEqual(actions,[{kind:'click',x:80,y:120,button:'left'},{kind:'type',text:'青山路18号，请轻放，核验码ABC123'},{kind:'key',key:'Enter'}])
 for(const note of['PRIVATE_USER_TEXT','青山路 18号，请轻放，核验码ABC123'])assert.throws(()=>keyboardActions(note,{x:80,y:120}))
 assert.throws(()=>keyboardActions(actions[1].text,{x:NaN,y:120}))
})
test('red baseline requires exact posted keyboard AXCannotComplete evidence and natural cleanup; it never becomes a functional pass',()=>{
 const os={foregroundPid:42,sessionExists:true,screenLocked:false,leftButtonDown:false,rightButtonDown:false,middleButtonDown:false,keysDown:[]},steps=[{action:'click',performed:true},{action:'type',performed:false,error:'FOCUS_CHANGED',before:{os},after:{os,native:{focusAttempt:{inputPosted:true,keyboardAXError:-25204}}}}],cleanup={passed:true},oracle={passed:false,textMatches:false,submitted:false}
 const red=keyboardVerdict({steps,oracle,cleanup,expected:'red'});assert.equal(red.status,'expected-red');assert.equal(red.comparisonAccepted,true);assert.equal(red.functionalPassed,false)
 for(const patch of[{error:'NATIVE_TIMEOUT'},{after:{os,native:{focusAttempt:{inputPosted:false,keyboardAXError:-25204}}}},{after:{os:{...os,foregroundPid:99},native:steps[1].after.native}},{afterError:'KEYBOARD_OS_NOT_IDLE'}])assert.equal(keyboardVerdict({steps:[steps[0],{...steps[1],...patch}],oracle,cleanup,expected:'red'}).comparisonAccepted,false)
 assert.equal(keyboardVerdict({steps,oracle,cleanup:{passed:false},expected:'red'}).comparisonAccepted,false)
 assert.equal(keyboardVerdict({steps,oracle,cleanup,expected:'green'}).comparisonAccepted,false)
})
test('green requires all three actual confirmations plus independent exact business acceptance and cleanup',()=>{
 const steps=['click','type','key'].map(action=>({action,performed:true})),oracle={passed:true,textMatches:true,submitted:true},cleanup={passed:true}
 assert.equal(keyboardVerdict({steps,oracle,cleanup}).functionalPassed,true)
 for(const value of[{steps:steps.slice(0,2),oracle,cleanup},{steps,oracle:{...oracle,textMatches:false},cleanup},{steps,oracle,cleanup:{passed:false}}])assert.equal(keyboardVerdict(value).functionalPassed,false)
})
