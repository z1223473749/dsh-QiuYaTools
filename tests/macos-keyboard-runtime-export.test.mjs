import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import childProcess from 'node:child_process'
import {Server} from 'node:net'
import {syncBuiltinESMExports} from 'node:module'
import {build} from 'esbuild'
import ts from 'typescript'

const root=fileURLToPath(new URL('../',import.meta.url))
const preparer=new URL('../scripts/test-macos-live-vision-keyboard.mjs',import.meta.url)
const carrier=resolve(root,'scripts/live-vision-external-carrier.mjs')

// Use the real preparer's build argument instead of maintaining a second entry string.
async function runtimeOptions(){
 const text=await readFile(preparer,'utf8'),source=ts.createSourceFile(preparer.pathname,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),calls=[]
 const walk=node=>{if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='build')calls.push(node);ts.forEachChild(node,walk)}
 walk(source);assert.equal(calls.length,1,'review a changed preparer build boundary');assert.equal(calls[0].arguments.length,1)
 const literal=node=>{
  if(ts.isStringLiteral(node))return node.text
  if(node.kind===ts.SyntaxKind.TrueKeyword)return true
  if(node.kind===ts.SyntaxKind.FalseKeyword)return false
  if(ts.isIdentifier(node)&&node.text==='root')return root
  assert(ts.isObjectLiteralExpression(node),'only static build options and the exact repository root are allowed')
  return Object.fromEntries(node.properties.map(property=>{assert(ts.isPropertyAssignment(property)&&ts.isIdentifier(property.name));return[property.name.text,literal(property.initializer)]}))
 }
 const options=literal(calls[0].arguments[0]);assert.equal(options.write,false);assert.equal(options.bundle,true)
 assert.match(options.stdin.contents,/export \{oracleRPC\} from '\.\/scripts\/live-vision-external-carrier\.mjs'/u)
 return {...options,logLevel:'silent'}
}

test('the actual keyboard runtime entry rejects the old missing oracleRPC export',async t=>{
 const source=await readFile(carrier,'utf8'),marker='export function oracleRPC(path) {'
 assert.equal(source.split(marker).length,2)
 const oldSource=source.replace(marker,'function oracleRPC(path) {')
 const options=await runtimeOptions()
 await assert.rejects(build({...options,plugins:[{name:'previous-export-only',setup(builder){builder.onLoad({filter:/live-vision-external-carrier\.mjs$/},({path})=>{assert.equal(resolve(path),carrier);return{contents:oldSource,loader:'js'}})}}]}),error=>{
  assert(Array.isArray(error.errors),error.message)
  assert(error.errors.some(item=>item.text.includes('No matching export')&&item.text.includes('oracleRPC')))
  t.diagnostic(error.errors.find(item=>item.text.includes('oracleRPC')).text)
  return true
 })
})

test('the actual keyboard entry builds and imports its complete runtime without spawning or listening',async t=>{
 const options=await runtimeOptions(),result=await build(options)
 assert(result.metafile.inputs['scripts/live-vision-external-carrier.mjs'])
 assert(result.metafile.inputs['src/features/computer-use/native.ts'])
 assert(result.metafile.inputs['scripts/live-vision-external-core.mjs'])
 const directory=await mkdtemp(join(tmpdir(),'qiuya-keyboard-import-')),runtime=join(directory,'runtime.mjs')
 t.after(()=>rm(directory,{recursive:true,force:true}));assert.equal(result.outputFiles.length,1)
 await writeFile(runtime,result.outputFiles[0].contents,{flag:'wx',mode:0o600})
 const calls=[],mocks=[]
 const blocked=name=>(...args)=>{calls.push(name);throw Error('Import attempted an external operation: '+name)}
 try{
  for(const method of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])mocks.push(t.mock.method(childProcess,method,blocked(method)))
  mocks.push(t.mock.method(Server.prototype,'listen',blocked('listen')));syncBuiltinESMExports()
  const module=await import(pathToFileURL(runtime).href)
  for(const key of ['NativeCompanionDriver','oracleRPC','sameExternalIdentity','sameExternalExecutable','externalIdentityRetired'])assert.equal(typeof module[key],'function',key)
  const prepareEntry=await import(preparer.href),boundaryEntry=await import(new URL('../scripts/test-macos-keyboard-boundary.mjs',import.meta.url).href)
  assert.equal(typeof prepareEntry.prepareKeyboardRepro,'function');assert.equal(typeof prepareEntry.runKeyboardRepro,'function')
  assert.equal(typeof boundaryEntry.runKeyboardBoundaryRepro,'function');assert.deepEqual(calls,[])
  t.diagnostic('Actual runtime and both keyboard entries imported; child-process launches 0, listeners 0; prepare/run/oracleRPC not invoked.')
 }finally{for(const mock of mocks.reverse())mock.mock.restore();syncBuiltinESMExports()}
})
