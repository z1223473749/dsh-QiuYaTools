/** Test-carrier file identity only; no process, GUI, network or input effects. */
import assert from 'node:assert/strict'
import {open,realpath,lstat} from 'node:fs/promises'
import {constants} from 'node:fs'
import {createHash} from 'node:crypto'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const fields = ['dev','ino','mode','uid','size','mtimeNs','ctimeNs','nlink']
const facts = (stat) => Object.fromEntries(fields.map(key=>[key,String(stat[key])]))
const phases = new Set(['image-file-pin','native-image-pin','native-image-recheck','guardian-image-pin'])
function failure(phase,actualPath,expected,code='REVERSE_EXECUTABLE_MISMATCH') {
  const error = Object.assign(new Error('Reverse executable identity could not be independently confirmed.'), {code})
  error.reverseExecutableFact = {phase:phases.has(phase)?phase:'image-file-pin',actualPathSHA256:hash(String(actualPath)),expectedPathSHA256:typeof expected?.canonical==='string'?hash(expected.canonical):null}
  return error
}
async function readCertificate(path,phase,expected) {
  let handle
  try {
    const canonical=await realpath(path)
    if(expected)assert.equal(canonical,expected.canonical)
    handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW)
    const before=await handle.stat({bigint:true})
    assert(before.isFile()&&before.size>0n&&before.size<=8n*1024n*1024n&&before.nlink===1n)
    assert.equal(before.mode&0o022n,0n);assert.notEqual(before.mode&0o111n,0n)
    if(typeof process.getuid==='function')assert.equal(before.uid,BigInt(process.getuid()))
    if(expected)assert.deepEqual(facts(before),expected.file)
    const digest=createHash('sha256');let position=0
    while(position<Number(before.size)){const b=Buffer.alloc(Math.min(65536,Number(before.size)-position)),r=await handle.read(b,0,b.length,position);assert(r.bytesRead>0);digest.update(b.subarray(0,r.bytesRead));position+=r.bytesRead}
    const extra=Buffer.alloc(1);assert.equal((await handle.read(extra,0,1,position)).bytesRead,0)
    const after=await handle.stat({bigint:true}),leaf=await lstat(path,{bigint:true})
    assert(leaf.isFile()&&!leaf.isSymbolicLink());assert.deepEqual(facts(after),facts(before));assert.deepEqual(facts(leaf),facts(before));assert.equal(await realpath(path),canonical)
    const sha256=digest.digest('hex');if(expected)assert.equal(sha256,expected.sha256)
    return {canonical,file:facts(before),sha256}
  } catch {throw failure(phase,path,expected)} finally {await handle?.close()}
}
export async function pinReverseExecutable(path,expectedSHA256) {
  assert.match(expectedSHA256,/^[a-f0-9]{64}$/u)
  const pin=await readCertificate(path,'image-file-pin');if(pin.sha256!==expectedSHA256)throw failure('image-file-pin',path,pin)
  return Object.freeze({...pin,file:Object.freeze(pin.file)})
}
export async function verifyReverseProcessExecutable(identity,pin,{pid,parentPid,phase='native-image-pin'}={}) {
  try {assert(Number.isSafeInteger(pid)&&pid>0&&Number.isSafeInteger(parentPid)&&parentPid>0);assert.equal(identity?.pid,pid);assert.equal(identity.parentPid,parentPid);assert.match(identity.startSeconds??'',/^\d{1,20}$/u);assert.match(identity.startMicroseconds??'',/^\d{1,6}$/u);assert(BigInt(identity.startSeconds)>0n);assert(BigInt(identity.startMicroseconds)<1000000n);assert.equal(typeof identity.executablePath,'string')}catch{throw failure(phase,identity?.executablePath,pin)}
  const observed=await readCertificate(identity.executablePath,phase,pin)
  return {phase,actualPathSHA256:hash(identity.executablePath),expectedPathSHA256:hash(pin.canonical),canonicalSHA256:hash(observed.canonical),imageSHA256:observed.sha256,file:{...observed.file},pid:identity.pid,parentPid:identity.parentPid,startSeconds:identity.startSeconds,startMicroseconds:identity.startMicroseconds}
}
