import assert from'node:assert/strict';
/** A failed business result never bypasses independent natural retirement or becomes success. */
export async function finishKnownRunnerPostflight({runner,report,readTask,auditPins,unregister}){
 assert.equal(runner.natural,true);assert.equal(runner.signal,null);assert.equal(runner.killCalls,0);assert.equal(runner.stdinClosed,true);assert([0,1].includes(runner.code),'Only known fixture natural0/1 can enter automatic postflight');
 const task=await readTask(runner.code);assert.equal(task.state,'Ready');assert.equal(task.result,runner.code,'Exact Ready result must match sealed natural runner exit');
 const retirement=await auditPins();assert.equal(retirement.passed,true,'Independent original pins must all be retired');
 assert(Array.isArray(report.cleanup)&&report.cleanup.length>0&&report.cleanup.every(r=>r?.passed===true),'Inner cleanup unknown: preserve exact task metadata');
 const retiredTask=await unregister(runner.code);assert.equal(retiredTask.unregistered,true,'Exact Task metadata deletion must be acknowledged');
 assert.equal(runner.code,0,'BUSINESS_FAILED_NATURAL_RETIREMENT_COMPLETE');assert.equal(report.passed,true,'BUSINESS_FAILED_NATURAL_RETIREMENT_COMPLETE');
 return{retirement,task:retiredTask};
}
