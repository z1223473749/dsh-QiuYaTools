/** Test-carrier coordination only: the client business body and its30s fence stay unchanged. */
import assert from 'node:assert/strict'
export function createReverseCheckpointCoordinator(runCheckpoint,onCompleted) {
  assert.equal(typeof runCheckpoint,'function');assert.equal(typeof onCompleted,'function')
  const seen=new Set();let tail=Promise.resolve(),failure
  return {
    notify(stage) {
      assert(['client-started','capture-only-passed'].includes(stage),'Unknown checkpoint stage')
      assert(!failure,'A rejected checkpoint cannot be replayed')
      assert(!seen.has(stage),'Duplicate checkpoint cannot be replayed')
      assert(stage!=='capture-only-passed'||seen.has('client-started'),'Capture cannot precede identity')
      seen.add(stage)
      const work=tail.then(async()=>{if(failure)throw failure;await runCheckpoint(stage);await onCompleted(stage)})
      tail=work.catch(error=>{failure??=error});return work
    },
    async settled(){await tail;if(failure)throw failure},
    stages(){return [...seen]}
  }
}
export function reverseClientReportEntry() {
  return `import assert from 'node:assert/strict';import{readFile}from'node:fs/promises';import{dirname,join}from'node:path';import{fileURLToPath,pathToFileURL}from'node:url';
const dir=dirname(fileURLToPath(import.meta.url)),client=join(dir,'client.mjs');assert.equal(process.argv[2],client,'Exact original client argv marker required');
const cfg=JSON.parse(await readFile(join(dir,'config.json'),'utf8')),base=new URL(cfg.fixtureBase);assert.equal(base.protocol,'http:');assert.match(base.pathname,/^\\/[a-f0-9-]{36}$/iu);assert.match(base.hostname,/^(?:127\\.0\\.0\\.1|10\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}|192\\.168\\.\\d{1,3}\\.\\d{1,3})$/u);
let fallback;try{await import(pathToFileURL(client).href)}catch{process.exitCode=1;fallback={passed:false,checks:[],error:'Owned original client failed before report persistence',cleanup:{passed:false,errors:['Original report unavailable']}}}
let bytes;try{bytes=await readFile(join(dir,'report.json'))}catch{assert(fallback);bytes=Buffer.from(JSON.stringify(fallback))}assert(bytes.length>0&&bytes.length<=65536);const value=JSON.parse(bytes);assert.equal(typeof value.passed,'boolean');assert(Array.isArray(value.checks)&&value.checks.length<=9);
const response=await fetch(base.href+'/client-report',{method:'POST',headers:{'content-type':'application/json'},body:bytes});assert.equal(response.status,200,'Owned report callback must be acknowledged');
`
}
