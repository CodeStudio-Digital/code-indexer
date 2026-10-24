import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { loadNativeHostBridge, parseRuntimePackageAnchor, verifyRuntimePackage } from '@mcp/agent-runtime-host';
import { NativePersistentCommandPort } from '../workers/native-persistent-command-port.js';

const physicalIt = process.platform === 'win32' && process.env.MCP_RUST_AGENT_PROCESS_REAL_E2E === '1' ? it : it.skip;
physicalIt('exchanges stdin and live stderr, bounds floods and reaps detached children on close', async () => {
  const runtime = await verifyRuntimePackage(resolve('dist/native-agent-runtime/x86_64-pc-windows-msvc'),
    parseRuntimePackageAnchor(await readFile('dist/apps/electron/native-agent-runtime-integrity.json')));
  const directory = await mkdtemp(join(tmpdir(), 'native-command-port-'));
  const unknown = vi.fn(); const abort = new AbortController();
  const pids: number[] = [];
  const port = new NativePersistentCommandPort(input => {
    const owner = loadNativeHostBridge(runtime).startNativeHostDuplexProcess!(input); pids.push(owner.processId); return owner;
  }, Date.now() + 30_000, abort.signal, unknown);
  await writeFile(join(directory, 'repl.cjs'), `
    const child = require('child_process').spawn(process.execPath, ['-e','setInterval(()=>{},1000)'], {detached:true,stdio:'ignore',windowsHide:true});
    console.error('PROMPT:' + child.pid);
    require('readline').createInterface({input:process.stdin}).on('line', line => {
      if (line === 'flood') console.log('HEAD' + 'x'.repeat(2000000) + 'TAIL');
      else console.error('echo:' + line);
    });
  `);
  const request = { command: `"${process.execPath}" repl.cjs`, cwd: directory, tty: false,
    maxOutputBytes: 4000, yieldMs: 500, assertFence() {} };
  try {
    const first = await port.start(request); expect(first.content).toContain('status=running');
    const sessionId = /session_id=(\w+)/.exec(first.content)![1];
    let prompt = first.content;
    await vi.waitFor(async () => { if (!prompt.includes('PROMPT:')) prompt += (await port.write({ sessionId, chars: '', yieldMs: 100, assertFence() {} })).content;
      expect(prompt).toContain('PROMPT:'); }, { timeout: 5000 });
    const child = Number(/PROMPT:(\d+)/.exec(prompt)![1]); pids.push(child); process.kill(child, 0);
    const response = await port.write({ sessionId, chars: 'ação\n', yieldMs: 100, assertFence() {} });
    expect(response.content).toContain('echo:ação');
    const flooded = await port.write({ sessionId, chars: 'flood\n', yieldMs: 500, assertFence() {} });
    expect(flooded.content).toContain('HEAD'); expect(flooded.content).toContain('TAIL');
    expect(flooded.sourceTruncations?.[0].inputSize).toBeGreaterThan(2_000_000);
    expect(flooded.content.length).toBeLessThan(4100);
    await port.close();
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
    expect(unknown).not.toHaveBeenCalled();
  } finally { abort.abort(); await port.close(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);

physicalIt('runs a real terminal with the requested size and interactive input under native containment', async () => {
  const runtime = await verifyRuntimePackage(resolve('dist/native-agent-runtime/x86_64-pc-windows-msvc'),
    parseRuntimePackageAnchor(await readFile('dist/apps/electron/native-agent-runtime-integrity.json')));
  const binding = loadNativeHostBridge(runtime);
  expect(binding.nativeHostBridgeAbi().pseudoconsoleVersion).toBe(1);
  const directory = await mkdtemp(join(tmpdir(), 'native-command-pty-'));
  const abort = new AbortController(); const unknown = vi.fn(); const pids: number[] = [];
  const port = new NativePersistentCommandPort(input => {
    const owner = binding.startNativeHostDuplexProcess!(input); pids.push(owner.processId); return owner;
  }, Date.now() + 30_000, abort.signal, unknown, true);
  await writeFile(join(directory, 'terminal.cjs'), `
    console.log('TTY:' + process.stdin.isTTY + ':' + process.stdout.isTTY + ':' + process.stdout.columns + ':' + process.stdout.rows);
    require('readline').createInterface({input:process.stdin}).on('line', line => {
      console.log('PTY_ACK:' + line); if (line === 'exit') process.exit(0);
    });
  `);
  try {
    const first = await port.start({ command: `"${process.execPath}" terminal.cjs`, cwd: directory,
      tty: true, columns: 90, rows: 25, maxOutputBytes: 8000, yieldMs: 500, assertFence() {} });
    const sessionId = /session_id=(\w+)/.exec(first.content)![1]; let output = first.content;
    await vi.waitFor(async () => {
      if (!output.includes('TTY:true:true:90:25')) output += (await port.write({ sessionId, chars: '', yieldMs: 100, assertFence() {} })).content;
      expect(output).toContain('TTY:true:true:90:25');
    }, { timeout: 5000 });
    const echoed = await port.write({ sessionId, chars: 'hello\r', yieldMs: 200, assertFence() {} });
    expect(echoed.content).toContain('PTY_ACK:hello');
    const exited = await port.write({ sessionId, chars: 'exit\r', yieldMs: 2000, assertFence() {} });
    expect(exited.content).toContain('PTY_ACK:exit'); expect(exited.content).toContain('status=exited exit=0');
    await port.close(); for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
    expect(unknown).not.toHaveBeenCalled();
  } finally { abort.abort(); await port.close(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);
