/** Barrel for the gated capability handlers used by buildHostInvoke. */
export { handleFs, scopePath } from './fs.js';
export { handleExec, isExecAllowed, type ExecResult } from './exec.js';
export { handleStorage } from './storage.js';
