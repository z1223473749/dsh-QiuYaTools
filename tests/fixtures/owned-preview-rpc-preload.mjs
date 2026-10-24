/** Import only in the newly disposable E2E Host. Normal/personal processes do nothing. */
import {isMainThread} from 'node:worker_threads'
import {realpathSync} from 'node:fs'
import {installOwnedPreviewRPCTrace} from './owned-preview-rpc-trace.mjs'
if(isMainThread&&process.env.QIUYA_HARNESS_E2E==='1'&&typeof process.env.DSH_HOME==='string'){
 try{const trace=installOwnedPreviewRPCTrace({profileRoot:realpathSync(process.env.DSH_HOME)});process.once('exit',()=>trace.stop())}catch{}
}
