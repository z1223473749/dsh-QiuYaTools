import test from 'node:test'
import assert from 'node:assert/strict'
import {projectVisionTurnError,projectVisionFailure} from '../scripts/live-vision-guard-core.mjs'
test('terminal LlmFailure keeps only fixed codes/categories, finite status and hashes without original message or provider identity',()=>{
 const value=projectVisionTurnError({code:'UNKNOWN',status:401,retryable:false,type:'authentication',message:'working-directory: directory does not exist: PRIVATE_PATH PRIVATE_TOKEN',requestId:'PRIVATE_REQUEST',headers:{Authorization:'PRIVATE_AUTH'}})
 assert.equal(value.code,'UNKNOWN');assert.equal(value.status,401);assert.equal(value.retryable,false);assert.deepEqual(value.categories,['workspace-missing']);assert.match(value.messageSHA,/^[a-f0-9]{64}$/u);assert.doesNotMatch(JSON.stringify(value),/PRIVATE|requestId|Authorization|headers/u)
 assert.equal(projectVisionFailure({code:'VISION_TURN_ERROR'},'owner-wait').code,'VISION_TURN_ERROR')
})
test('unknown terminal codes/types/messages are not emitted and do not authorize retry or a new model request',()=>{
 const value=projectVisionTurnError({code:'PRIVATE_CODE',type:'PRIVATE_TYPE',status:Infinity,retryable:'PRIVATE_VALUE',message:'PRIVATE_MESSAGE'})
 assert.equal(value.code,null);assert.match(value.unknownCodeSHA,/^[a-f0-9]{64}$/u);assert.equal(value.type,null);assert.equal(value.status,null);assert.equal(value.retryable,null);assert.deepEqual(value.categories,[]);assert.doesNotMatch(JSON.stringify(value),/PRIVATE/u)
 assert.deepEqual(projectVisionTurnError(null),{code:null,unknownCodeSHA:null,status:null,retryable:null,type:null,messageSHA:null,messageBytes:null,categories:[]})
})
