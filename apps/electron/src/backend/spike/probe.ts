/**
 * THROWAWAY — Onda 0 spike. Delete once the gate is answered.
 *
 * Runs inside `utilityProcess.fork` and reports what actually works there.
 * Every assertion below is a thing the backend-host migration depends on and
 * that nothing in this repo currently proves (`utilityProcess` appears nowhere
 * today). The expensive assertion is `sqlite`: better-sqlite3 is built for the
 * Electron ABI and lives in `asarUnpack`, and if Electron's asar shim is not
 * active in a utility process, the whole packaging model has to change.
 */

import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';

const require = createRequire(import.meta.url);

interface SpikeCheck {
  name: string;
  ok: boolean;
  detail: string;
}

interface SpikeReport {
  env: Record<string, string>;
  checks: SpikeCheck[];
}

function check(name: string, fn: () => string): SpikeCheck {
  try {
    return { name, ok: true, detail: fn() };
  } catch (err) {
    return { name, ok: false, detail: (err as Error)?.message ?? String(err) };
  }
}

async function checkAsync(name: string, fn: () => Promise<string>): Promise<SpikeCheck> {
  try {
    return { name, ok: true, detail: await fn() };
  } catch (err) {
    return { name, ok: false, detail: (err as Error)?.message ?? String(err) };
  }
}

/** (c) A worker_thread spawned from the utility must round-trip a message. */
function workerRoundTrip(): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      "const {parentPort}=require('node:worker_threads');parentPort.postMessage('pong');",
      { eval: true },
    );
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error('worker did not answer within 10s'));
    }, 10_000);
    worker.on('message', (m) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(`round-trip ok (${String(m)})`);
    });
    worker.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

export async function runProbe(): Promise<SpikeReport> {
  const checks: SpikeCheck[] = [];

  // (b) THE gate. `new Database` is the real ABI test — a bare require()
  // succeeds even when the native addon cannot load.
  checks.push(check('sqlite', () => {
    const Database = require('better-sqlite3') as new (p: string) => { prepare: (s: string) => { get: () => unknown }; close: () => void };
    const db = new Database(':memory:');
    const row = db.prepare('select sqlite_version() as v').get() as { v: string };
    db.close();
    return `opened :memory:, sqlite ${row.v}`;
  }));

  checks.push(check('sqlite-from-asar', () => {
    const p = require.resolve('better-sqlite3');
    return `${p.includes('app.asar') ? 'RESOLVED INSIDE app.asar' : 'resolved outside asar'} — ${p}`;
  }));

  checks.push(await checkAsync('worker_threads', workerRoundTrip));

  // (f) node-pty is prebuildify/N-API so it should not care about the ABI, but
  // it has never been loaded outside the main process here.
  checks.push(check('node-pty', () => {
    const pty = require('node-pty') as { spawn?: unknown };
    if (typeof pty.spawn !== 'function') throw new Error('node-pty loaded but spawn is missing');
    return 'loaded, spawn present';
  }));

  checks.push(check('sqlite-vec', () => {
    const p = require.resolve('sqlite-vec');
    return `resolvable — ${p}`;
  }));

  return {
    env: {
      'process.versions.electron': process.versions.electron ?? '(undefined)',
      'process.versions.node': process.versions.node,
      'process.execPath': process.execPath,
      'process.resourcesPath': (process as { resourcesPath?: string }).resourcesPath ?? '(undefined)',
      'process.type': (process as { type?: string }).type ?? '(undefined)',
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? '(unset)',
      'require.main': import.meta.url,
    },
    checks,
  };
}
