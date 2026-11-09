import { parentPort } from 'node:worker_threads';
import { disposeGitProcesses, runGitProcess } from './git-process.js';
import type { GitReadRequest, GitReadResponse } from './git-read-protocol.js';

let closing = false;
const jobs = new Set<Promise<void>>();
const controllers = new Map<number, AbortController>();
const post = (message: GitReadResponse) => parentPort?.postMessage(message);
parentPort?.on('message', (message: GitReadRequest) => {
  if (message.type === 'cancel') { controllers.get(message.id)?.abort(); return; }
  if (message.type === 'dispose') {
    closing = true;
    void disposeGitProcesses().then(() => Promise.allSettled([...jobs])).finally(() => parentPort?.close());
    return;
  }
  if (closing) { post({ type: 'result', id: message.id, result: { code: -1, stdout: '', stderr: 'Git reader is closing', errorCode: 'spawn_failed' } }); return; }
  const pid = new Int32Array(message.pid);
  const controller = new AbortController();
  controllers.set(message.id, controller);
  const job = runGitProcess(message.input, childPid => {
    // The host can recover this ownership even if a crash loses the message.
    Atomics.store(pid, 0, childPid);
    post({ type: 'spawned', id: message.id, pid: childPid });
  }, controller.signal).then(result => {
    Atomics.store(pid, 0, 0);
    post({ type: 'result', id: message.id, result });
  }).finally(() => { jobs.delete(job); controllers.delete(message.id); });
  jobs.add(job);
});
parentPort?.once('close', () => { void disposeGitProcesses(); });
