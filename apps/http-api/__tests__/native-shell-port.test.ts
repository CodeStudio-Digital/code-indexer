import { expect, it, vi } from 'vitest';
import { NativeShellPort } from '../workers/native-shell-port.js';
import type { NativeHostCommand } from '@mcp/agent-runtime-host';

it.skipIf(process.platform !== 'win32')('does not release the scope when a native wait fails to prove physical cleanup', async () => {
  const owner: NativeHostCommand = { processId: 99, cancel: vi.fn(), wait: async () => { throw new Error('reap failed'); } };
  const port = new NativeShellPort(() => owner, Date.now() + 5000, new AbortController().signal);
  await expect(port.spawn(process.execPath, [], { cwd: process.cwd(), timeoutMs: 1000 })).rejects.toThrow('reap failed');
  await expect(port.close()).rejects.toThrow('unproven cleanup');
});

it('refuses command effects after the workspace deadline without invoking the bridge', () => {
  const start = vi.fn();
  const port = new NativeShellPort(start, Date.now() - 1, new AbortController().signal);
  expect(() => port.exec('echo forbidden', { cwd: process.cwd(), timeoutMs: 1000 })).toThrow('lease expired');
  expect(start).not.toHaveBeenCalled();
});
