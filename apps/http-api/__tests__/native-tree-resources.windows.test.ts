import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadNativeHostBridge, parseRuntimePackageAnchor, verifyRuntimePackage } from '@mcp/agent-runtime-host';
import { NativeTreeResources } from '../workers/native-tree-resources.js';

const physicalIt = process.platform === 'win32' && process.env.MCP_RUST_AGENT_PROCESS_REAL_E2E === '1' ? it : it.skip;
physicalIt('reserves actual command Jobs together, rejects before launch and releases after physical reap', async () => {
  const runtimePackage = await verifyRuntimePackage(resolve('dist/native-agent-runtime/x86_64-pc-windows-msvc'),
    parseRuntimePackageAnchor(await readFile(resolve('dist/apps/electron/native-agent-runtime-integrity.json'))));
  const binding = loadNativeHostBridge(runtimePackage), bounds = binding.nativeHostBridgeAbi().resourceBounds!;
  expect(bounds).toMatchObject({ version: 1, supervisorProcesses: 17, commandProcesses: 128, duplexProcesses: 32 });
  const resources = new NativeTreeResources(new AbortController().signal, {
    memoryBytes: bounds.commandMemoryBytes + bounds.supervisorMemoryBytes,
    processes: bounds.commandProcesses + bounds.supervisorProcesses,
  });
  const parent = resources.bind(binding), child = resources.bind(binding), releaseParent = parent.reserveRuntime();
  const options = { executable: process.execPath, arguments: ['-e', 'setTimeout(() => {}, 10000)'], cwd: process.cwd(),
    environment: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } as Record<string, string>, stdin: new Uint8Array(),
    maximumOutputBytes: 100, timeoutMs: 15000 };
  const first = parent.startCommand!(options); let second: ReturnType<NonNullable<typeof child.startDuplex>> | undefined;
  try {
    expect(first.processId).toBeGreaterThan(0);
    expect(resources.snapshot()).toEqual({ ...resources.limits, groups: 2 });
    expect(() => child.startDuplex!(options)).toThrow('resource budget exhausted');
    first.cancel(); const stopped = await first.wait();
    expect(stopped).toMatchObject({ reaped: true, cancelled: true });
    expect(resources.snapshot().groups).toBe(1);
    second = child.startDuplex!({ ...options, arguments: ['-e', 'process.stdout.write("bounded")'] });
    expect((await second.wait()).reaped).toBe(true);
    expect(resources.snapshot().groups).toBe(1);
  } finally {
    first.cancel(); second?.cancel(); await Promise.all([first.wait(), second?.wait()]); releaseParent();
  }
  expect(resources.snapshot()).toEqual({ memoryBytes: 0, processes: 0, groups: 0 });
}, 30000);
