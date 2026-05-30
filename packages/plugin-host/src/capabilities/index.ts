/** Barrel for the gated capability handlers used by buildHostInvoke. */
export { handleFs, scopePath } from './fs.js';
export { handleExec, execStream, isExecAllowed, type ExecResult, type ExecChunk } from './exec.js';
export { handleStorage } from './storage.js';
