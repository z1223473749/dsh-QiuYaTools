/** Unit-only strict entry contract. No PD executable or archive is used by its plan. */
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {join,dirname} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'
import { harnessPostflight } from './postflight-assets.mjs'
const base=dirname(fileURLToPath(import.meta.url)),data=JSON.parse(await readFile(join(base,'prepare-data.json'),'utf8'))
const arg=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1]}
const planning=process.argv.includes('--plan'),executing=process.argv.includes('--run')
assert.notEqual(planning, executing, 'Pass exactly one of --plan or --run')
const architecture=arg('--arch');assert(['arm64','x64'].includes(architecture))
const digest=bytes=>createHash('sha256').update(bytes).digest('hex')
assert.equal(digest(await readFile(fileURLToPath(import.meta.url))),data.entrySHA256,'Prepared entry changed')
assert.equal(arg('--expected-sha256'),data.candidates[architecture].sha256)
assert.equal(digest(await readFile(arg('--package'))),data.candidates[architecture].sha256,'Package differs from receipt')
for (const [name, hash] of Object.entries(data.snapshotHashes)) assert.equal(digest(await readFile(join(data.snapshot,name))),hash,'Snapshot changed')
const mode={QIUYA_WINDOWS_MANUAL_PREVIEW: '1',QIUYA_WINDOWS_DRAG_WINDOW: '1',QIUYA_WINDOWS_FILE_EXCHANGE: '1'}
const scope='current strict feature-evidence subset; full-suite results preserved in1160'
if(planning){console.log(JSON.stringify({status:'prepared-not-run',guiStarted:false,windowsCommandsExecuted:false,installLifecycle:!process.argv.includes('--no-install'),candidateSHA256:arg('--expected-sha256'),mode,scope}));process.exit(0)}
const output=arg('--output')
try { await import(pathToFileURL(join(data.snapshot, 'scripts/e2e-windows-harness-pd.mjs')).href) }
finally {await harnessPostflight(output)}
