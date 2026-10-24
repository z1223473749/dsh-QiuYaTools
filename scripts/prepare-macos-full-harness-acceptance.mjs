import{boundedFile}from'./macos-acceptance-files.mjs';
/** Portable Mac full12 preparation; explicit options, no historical candidate or binary default. */
import assert from'node:assert/strict';import{readFile,realpath}from'node:fs/promises';import{resolve}from'node:path';import{fileURLToPath,pathToFileURL}from'node:url';import{preparePortableMacFull12}from'./prepare-macos-portable-full12.mjs';
export{MAC_FULL_HARNESS_CASES,assertMacFullHarnessGate,makeMacFullHarnessSource,assessMacFullHarnessReport,verifyMacFullHarnessBinding,bindReadonlyOracleHost}from'./macos-full-harness-policy.mjs';
export const prepareMacFullHarnessAcceptance=preparePortableMacFull12;
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){assert.equal(process.argv.length,3,'Pass one explicit canonical options.json');const path=await realpath(process.argv[2]);const bytes=await boundedFile(path,65536);console.log(JSON.stringify(await preparePortableMacFull12(JSON.parse(bytes)),null,2))}
