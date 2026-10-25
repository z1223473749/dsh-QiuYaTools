/** Only own DevTools ready-file sharing contention is pending; unknown errors remain fatal. */
export function recordOwnBrowserReadyFilePending(error,expectedPath,facts){
 const code=error?.code==='ENOENT'?'ENOENT':error?.code==='EBUSY'&&error.syscall==='open'&&error.path===expectedPath?'EBUSY':null;
 if(code){facts.pendingErrorCounts[code]++;facts.lastErrorCode=code;return true}
 facts.rejectedErrorCount++;facts.lastErrorCode=['EACCES','EPERM','EBUSY','EIO','ENOTDIR'].includes(error?.code)?error.code:'UNCLASSIFIED';return false
}
