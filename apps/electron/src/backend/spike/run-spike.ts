/**
 * THROWAWAY — Onda 0 spike. Delete once the gate is answered.
 *
 * Main-process driver. Gated on `MCP_BACKEND_SPIKE=1` so it never runs for a
 * normal launch. Forks a utility process, transfers it one end of a
 * MessageChannelMain, waits for the capability report and prints a verdict
 * table to stdout.
 *
 * Run it in BOTH modes — the dev path and the packaged path exercise different
 * entry resolution and different asar behaviour, and the packaged one is the
 * one that can fail:
 *   MCP_BACKEND_SPIKE=1 pnpm electron:dev
 *   MCP_BACKEND_SPIKE=1 <installed CodeStudio.exe>
 */

import { MessageChannelMain, utilityProcess } from 'electron';
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface SpikeCheck { name: string; ok: boolean; detail: string }
interface SpikeReport { env: Record<string, string>; checks: SpikeCheck[] }

const TIMEOUT_MS = 60_000;

/** Compiled (`.js` caller) → sibling `.js`. Source (tsx dev) → the bootstrap. */
function entrySpec(): { path: string; args: string[] } {
  if (import.meta.url.endsWith('.ts')) {
    return {
      path: fileURLToPath(new URL('./_bootstrap.mjs', import.meta.url)),
      args: [fileURLToPath(new URL('./entry.ts', import.meta.url))],
    };
  }
  return { path: fileURLToPath(new URL('./entry.js', import.meta.url)), args: [] };
}

/**
 * A packaged Electron app is a GUI binary — its stdout goes nowhere the
 * operator can read, and redirected stdout is block-buffered anyway. So every
 * line also goes to a file, synchronously. Override with `MCP_BACKEND_SPIKE_OUT`.
 */
const OUT_PATH = process.env.MCP_BACKEND_SPIKE_OUT ?? join(tmpdir(), 'mcp-backend-spike.log');

function say(text: string): void {
  console.log(text);
  try { appendFileSync(OUT_PATH, `${text}\n`); } catch { /* best effort */ }
}

function print(report: SpikeReport, portEcho: string): void {
  const line = '─'.repeat(78);
  say(`\n${line}\n[spike] utilityProcess capability report\n${line}`);
  for (const [k, v] of Object.entries(report.env)) say(`  ${k.padEnd(28)} ${v}`);
  say(line);
  for (const c of report.checks) {
    say(`  ${(c.ok ? 'PASS' : 'FAIL').padEnd(5)} ${c.name.padEnd(22)} ${c.detail}`);
  }
  say(`  ${'PASS'.padEnd(5)} ${'port-echo'.padEnd(22)} ${portEcho}`);
  const failed = report.checks.filter((c) => !c.ok);
  say(line);
  say(failed.length ? `[spike] ${failed.length} FAILED: ${failed.map((c) => c.name).join(', ')}` : '[spike] all checks passed');
  say(`${line}\n`);
}

export function runBackendSpike(): void {
  if (process.env.MCP_BACKEND_SPIKE !== '1') return;
  const spec = entrySpec();
  console.log(`[spike] forking ${spec.path}${spec.args.length ? ` ${spec.args.join(' ')}` : ''}`);

  const child = utilityProcess.fork(spec.path, spec.args, {
    serviceName: 'CodeStudio Backend (spike)',
    stdio: 'inherit',
  });

  const { port1, port2 } = new MessageChannelMain();
  let echo = '(no traffic)';
  port1.on('message', (e) => {
    const d = e.data as { type?: string; from?: string } | undefined;
    if (d?.type === 'hello') {
      echo = `utility→main ok (${d.from})`;
      port1.postMessage({ type: 'ping', from: 'main' });
    }
    if (d?.type === 'pong') echo = `bidirectional ok (${d.from})`;
  });
  port1.start();

  const timer = setTimeout(() => {
    console.error(`[spike] TIMEOUT after ${TIMEOUT_MS}ms — no report. The utility likely failed to load its entry.`);
    child.kill();
  }, TIMEOUT_MS);

  child.on('spawn', () => {
    console.log(`[spike] utility spawned pid=${child.pid}`);
    // Transferring port2 INTO the utility is assertion (d).
    child.postMessage({ type: 'start' }, [port2]);
  });
  child.on('message', (msg: { type?: string; report?: SpikeReport; message?: string }) => {
    if (msg?.type === 'fatal') {
      clearTimeout(timer);
      console.error(`[spike] child reported fatal: ${msg.message}`);
      child.kill();
      return;
    }
    if (msg?.type !== 'report' || !msg.report) return;
    clearTimeout(timer);
    print(msg.report, echo);
    child.kill();
  });
  child.on('exit', (code) => {
    clearTimeout(timer);
    console.log(`[spike] utility exited code=${code}`);
  });
}
