import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { loadNativeHostBridge, parseRuntimePackageAnchor, verifyRuntimePackage } from '@mcp/agent-runtime-host';
import { NativeShellPort } from '../workers/native-shell-port.js';

const physicalIt = process.platform === 'win32' && process.env.MCP_RUST_AGENT_PROCESS_REAL_E2E === '1' ? it : it.skip;
physicalIt('executes contained commands and Git with real Node-API output, cancellation and bounded capture', async () => {
  const runtime = await verifyRuntimePackage(resolve('dist/native-agent-runtime/x86_64-pc-windows-msvc'),
    parseRuntimePackageAnchor(await readFile(resolve('dist/apps/electron/native-agent-runtime-integrity.json'))));
  const binding = loadNativeHostBridge(runtime);
  expect(binding.startNativeHostCommand).toBeTypeOf('function');
  const cancel = new AbortController();
  const port = new NativeShellPort(binding.startNativeHostCommand!, Date.now() + 60_000, cancel.signal);
  const cwd = resolve('.');
  const command = await port.exec('echo "contained quote"&&echo second', { cwd, timeoutMs: 5000 });
  expect(command.exitCode).toBe(0);
  expect(command.stdout).toContain('"contained quote"');
  expect(command.stdout).toContain('second');
  expect((await port.run('git', ['--version'], { cwd })).stdout).toContain('git version');
  const big = await port.spawn(process.execPath, ['-e', 'process.stdout.write("HEAD"+"x".repeat(200000)+"TAIL")'],
    { cwd, timeoutMs: 5000, maxOutputBytes: 128 });
  expect(Buffer.byteLength(big.stdout)).toBeLessThanOrEqual(128);
  expect(big.stdout.startsWith('HEAD')).toBe(true);
  expect(big.stdout.endsWith('TAIL')).toBe(true);
  expect(big.stdoutTruncation?.inputBytes).toBe(200008);
  const active = port.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd, timeoutMs: 30_000 });
  cancel.abort();
  expect((await active).exitCode).toBeNull();
  await port.close();
  expect(() => port.exec('echo forbidden', { cwd, timeoutMs: 1000 })).toThrow('closed');
}, 30_000);
