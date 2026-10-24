/** Explicit native regression entry. No browser, desktop, model or input is launched. */
import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
const args=process.argv.slice(2),at=args.indexOf('--dotnet'),dotnet=at<0?process.env.QIUYA_DOTNET:args[at+1]
if(args.some((value,index)=>!(index===at||index===at+1&&at>=0)))throw Error('Only --dotnet <pinned SDK executable> is accepted')
const child=spawn(process.execPath,['--test',fileURLToPath(new URL('../tests/native/windows-journal-files.test.mjs',import.meta.url))],{stdio:'inherit',env:{...process.env,...(dotnet?{QIUYA_DOTNET:dotnet}:{})}})
child.once('error',error=>{console.error(error.message);process.exitCode=1})
child.once('exit',(code,signal)=>{if(signal||code!==0)process.exitCode=1})
