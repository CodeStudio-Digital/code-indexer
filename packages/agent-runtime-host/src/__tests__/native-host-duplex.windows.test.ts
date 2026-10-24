import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { loadNativeHostBridge } from '../native/NativeHostBridgeLoader.js';
import { verifyRuntimePackage } from '../packaging/RuntimePackageVerifier.js';
import { parseRuntimePackageAnchor } from '../packaging/RuntimePackageManifest.js';
import type { NativeHostDuplexProcess } from '../native/NativeHostDuplexProcess.js';

const physicalIt = process.platform === 'win32' && process.env.MCP_RUST_AGENT_PROCESS_REAL_E2E === '1' ? it : it.skip;
async function start(code: string): Promise<NativeHostDuplexProcess> {
 const runtime = await verifyRuntimePackage(resolve('dist/native-agent-runtime/x86_64-pc-windows-msvc'),
  parseRuntimePackageAnchor(await readFile('dist/apps/electron/native-agent-runtime-integrity.json')));
 const binding = loadNativeHostBridge(runtime);
 if (!binding.startNativeHostDuplexProcess) throw Error('missing native duplex API');
 return binding.startNativeHostDuplexProcess({ executable: process.execPath, arguments: ['-e', code],
  cwd: process.cwd(), environment: Object.fromEntries(Object.entries(process.env).filter((pair): pair is [string, string] => pair[1] !== undefined)), timeoutMs: 10_000 });
}
async function line(owner: NativeHostDuplexProcess) {
 let result = '';
 while (!result.endsWith('\n')) { const bytes = await owner.read(); if (!bytes) throw Error('unexpected EOF'); result += Buffer.from(bytes).toString(); }
 return result.trim();
}
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }

physicalIt('exchanges frames without closing stdin and clears transferred buffers', async () => {
 const owner = await start('process.stdin.on("data", bytes => process.stdout.write(bytes));');
 const exited = owner.wait();
 try {
  for (const text of ['first', 'second', 'third']) {
   const bytes = Buffer.from(text + '\n');
   const sent = owner.write(bytes);
   expect(bytes.every(value => value === 0)).toBe(true);
   await sent.wait();
   expect(await line(owner)).toBe(text);
  }
  const pending = owner.read();
  await expect(owner.read()).rejects.toThrow('reader already active');
  owner.cancel();
  expect(await pending).toBeNull();
  const receipt = await exited;
  expect(receipt, JSON.stringify({ exitCode: receipt.exitCode, stderr: Buffer.from(receipt.stderrHead).toString() }))
    .toMatchObject({ reaped: true, cancelled: true });
  expect(alive(owner.processId)).toBe(false);
 } finally { owner.cancel(); await exited; }
}, 20_000);

physicalIt('reaps a detached descendant after the stdio root exits', async () => {
 const code = 'const c=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore",windowsHide:true});console.log(c.pid);c.unref();';
 const owner = await start(code);
 const exited = owner.wait();
 let child: number | undefined;
 try {
  child = Number(await line(owner));
  expect(Number.isInteger(child) && child > 0).toBe(true);
  expect(await exited).toMatchObject({ reaped: true, exitCode: 0 });
  await vi.waitFor(() => { expect(alive(owner.processId)).toBe(false); expect(alive(child!)).toBe(false); });
 } finally {
  owner.cancel(); await exited;
  if (child && alive(child)) process.kill(child, 'SIGKILL');
 }
}, 20_000);

physicalIt.each([0, 1, 2, 3, 4, 5])('cancels a full output queue without waiting for its consumer: %s', async () => {
 const owner = await start('process.stdout.write("x".repeat(4*1024*1024));setInterval(()=>{},1000);');
 const exited = owner.wait();
 try {
  await new Promise(resolve => setTimeout(resolve, 200));
  const began = performance.now(); owner.cancel();
  const receipt = await exited;
  expect(receipt, JSON.stringify({ exitCode: receipt.exitCode, stderr: Buffer.from(receipt.stderrHead).toString() }))
    .toMatchObject({ reaped: true, cancelled: true });
  expect(performance.now() - began).toBeLessThan(3000);
 } finally { owner.cancel(); await exited; }
}, 20_000);
