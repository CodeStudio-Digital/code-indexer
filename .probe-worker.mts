import { Worker } from 'node:worker_threads';
const url = new URL('./packages/indexer/src/workers/indexJob/worker.ts', `file://${process.cwd().replace(/\\/g, '/')}/`);
console.log('spawning', url.href);
const w = new Worker(url);
w.on('message', (m) => { console.log('MSG', m); process.exit(0); });
w.on('error', (e) => { console.log('ERR', e.message); process.exit(1); });
w.on('exit', (c) => { console.log('EXIT', c); process.exit(2); });
setTimeout(() => { console.log('TIMEOUT'); process.exit(3); }, 8000);
