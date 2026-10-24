/** One VM pause-idle flag only. Fresh reads, no redundant write, no unknown-result replay. */
export function readWindowsPauseIdle(stdout){if(typeof stdout!=='string'||Buffer.byteLength(stdout)>65536)throw Error('VISION_WINDOWS_IDLE_SETTING');const rows=[...stdout.matchAll(/^\s*Pause idle:\s*(on|off)\s*$/gmu)];if(rows.length!==1)throw Error('VISION_WINDOWS_IDLE_SETTING');return rows[0][1]}
export async function ensureWindowsPauseIdle({vm,desired,command,persist,now=Date.now}){
 if(!/^[a-f0-9-]{36}$/u.test(vm??'')||!['on','off'].includes(desired)||typeof command!=='function'||typeof persist!=='function')throw Error('VISION_WINDOWS_IDLE_SETTING')
 const start=now(),deadline=start+30000,facts={version:1,desired,passed:false,observedBefore:null,observedAfter:null,mutated:false,setIssued:false,readQueries:0,setCommands:0,budgetMs:30000,unknown:false,noReplay:true};let failure
 const left=()=>{const ms=deadline-now();if(ms<=0)throw Error('VISION_WINDOWS_IDLE_DEADLINE');return Math.floor(ms)}
 try{
  facts.readQueries++;const before=await command('pd-read-current-idle',['list','--info',vm],{timeout:left(),maxBuffer:65536});left();facts.observedBefore=readWindowsPauseIdle(before.stdout)
  if(facts.observedBefore!==desired){facts.setIssued=true;facts.setCommands++;await command('pd-set-idle-once',['set',vm,'--pause-idle',desired],{timeout:left(),maxBuffer:65536});left();facts.mutated=true}
  facts.readQueries++;const after=await command('pd-verify-fresh-idle',['list','--info',vm],{timeout:left(),maxBuffer:65536});left();facts.observedAfter=readWindowsPauseIdle(after.stdout);if(facts.observedAfter!==desired)throw Error('VISION_WINDOWS_IDLE_RESTORE');facts.passed=true
 }catch(error){facts.unknown=true;failure=error}
 facts.elapsedMs=now()-start
 try{await persist(structuredClone(facts));left()}catch(error){failure??=error}
 if(failure)throw failure;return facts
}
