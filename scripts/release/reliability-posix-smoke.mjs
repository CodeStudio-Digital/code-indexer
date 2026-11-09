/** Run in the owned Linux container, with the built workspace mounted read-only. */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { superviseCodeExec } from '../../dist/packages/code-agent/src/tools/code-exec-supervisor.js';
import { killProcessTree } from '../../dist/packages/shared/src/utils/process-tree.js';

assert.equal(process.platform, 'linux');
const results = [], owned = [];
const bootstrap = { timeoutMs: 250, maxOutputBytes: 10_000, priorityErrorBytes: 1000,
  tools: ['read_step'], schemas: [], listing: [], changes: [], stash: [] };
const handlers = { invoke: async () => ({ value: 42 }), log() {}, logOmission() {}, stash() {}, ready() {} };
const valid = superviseCodeExec({ ...bootstrap, code: '(async () => (await tools.read_step({})).value)()' }, handlers);
owned.push(valid.pid);
try { assert.equal(await valid.promise, 42); } finally { await valid.close(); }
let ticks = 0;
const clock = setInterval(() => ticks++, 10);
const loop = superviseCodeExec({ ...bootstrap, code: '(async () => { await tools.read_step({}); while (true) {} })()' }, handlers);
owned.push(loop.pid);
try { await assert.rejects(loop.promise, /stopped responding|CPU budget|timed out/); }
finally { clearInterval(clock); await loop.close(); }
assert.ok(ticks > 5);
results.push({ codeExec: 'passed', postAwaitLoop: 'contained', hostTicks: ticks });

// A control process outside the target group must survive the group kill.
const control = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
const parentCode = `const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
console.log(JSON.stringify({ parent: process.pid, grandchild: child.pid }));
setInterval(() => {}, 1000);`;
const parent = spawn(process.execPath, ['-e', parentCode], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
const parentClosed = new Promise(done => parent.once('close', done));
const controlClosed = new Promise(done => control.once('close', done));
let tree;
try {
  tree = await new Promise((done, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error('fixture startup timeout')), 5000);
    parent.stdout.on('data', chunk => {
      text += chunk;
      if (text.includes('\n')) { clearTimeout(timer); done(JSON.parse(text.trim())); }
    });
    parent.once('error', error => { clearTimeout(timer); reject(error); });
  });
  owned.push(tree.parent, tree.grandchild);
  await killProcessTree(parent.pid); await parentClosed;
  process.kill(control.pid, 0);
  results.push({ processGroup: tree, unrelatedControlPreserved: true });
} finally { await killProcessTree(parent.pid); control.kill('SIGKILL'); await controlClosed; }
const alive = pid => { try { return !/^State:\s+Z/m.test(readFileSync(`/proc/${pid}/status`, 'utf8')); } catch { return false; } };
for (let attempt = 0; attempt < 100 && owned.some(alive); attempt++) await delay(20);
const remaining = owned.filter(alive);
assert.deepEqual(remaining, []);
writeFileSync(process.argv[2], JSON.stringify({ at: new Date().toISOString(), platform: process.platform,
  node: process.version, results, ownedPids: owned, remaining }, null, 2));
console.log('PASS POSIX executor and process-group cleanup');
