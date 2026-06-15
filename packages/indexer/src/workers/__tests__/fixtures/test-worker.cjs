// Test worker for pool.test.ts — behavior driven by message body:
//   { cmd: 'echo',  payload }            → replies with payload
//   { cmd: 'slow',  payload, delayMs }   → replies after delayMs
//   { cmd: 'fail' }                      → ok:false error reply
//   { cmd: 'crash' }                     → process.exit(13)
// workerData { bootCrash: true } exits before the ready handshake.
const { parentPort, workerData } = require('node:worker_threads');

if (workerData && workerData.bootCrash) process.exit(7);

parentPort.postMessage({ kind: 'ready' });
parentPort.on('message', (msg) => {
  const { reqId, body } = msg;
  const { cmd, payload, delayMs } = body || {};
  if (cmd === 'crash') process.exit(13);
  if (cmd === 'slow') {
    setTimeout(() => parentPort.postMessage({ reqId, ok: true, result: payload }), delayMs || 30);
    return;
  }
  if (cmd === 'fail') {
    parentPort.postMessage({ reqId, ok: false, error: { message: 'fake failure', code: 'FAKE' } });
    return;
  }
  parentPort.postMessage({ reqId, ok: true, result: payload });
});
