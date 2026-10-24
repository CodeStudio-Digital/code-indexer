import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
const directory = process.argv[2];
assert(directory && !directory.includes('..'));
const spec = resolve(directory + '-spec.json');
await writeFile(spec, JSON.stringify({ executable: process.execPath,
  arguments: ['scripts/test-process-tree-fixture.mjs', 'timeout'], timeoutSeconds: 30 }));
const supervisor = spawn('pwsh', ['-NoProfile', '-File', 'scripts/run-tracked-test.ps1', '-Spec', spec,
  '-RunDirectory', directory], { windowsHide: true, stdio: 'ignore' });
const ended = new Promise((resolve, reject) => { supervisor.once('exit', resolve); supervisor.once('error', reject); });
let pids = [];
for (let i = 0; i < 100; i++) {
  const events = await readFile(join(directory, 'processes.jsonl'), 'utf8').catch(() => '');
  pids = [...new Set(events.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(e => e.event === 'started').map(e => e.pid))];
  if (pids.length >= 4) break;
  await pause(100);
}
assert(pids.length >= 4, 'nested job did not register its root, console host and two detached descendants');
assert(supervisor.kill(), 'could not terminate the owned supervisor'); await ended;
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };
for (let i = 0; i < 100 && pids.some(alive); i++) await pause(50);
assert.deepEqual(pids.filter(alive), [], 'children survived the supervisor crash');
console.log(JSON.stringify({ passed: true, killedSupervisorPid: supervisor.pid, observedOwnedPids: pids, remaining: [] }));
