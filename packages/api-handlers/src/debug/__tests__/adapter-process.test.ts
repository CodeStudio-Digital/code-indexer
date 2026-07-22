import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { reserveLoopbackPort, startDebugTarget } from '../adapter-process.js';

describe('reserveLoopbackPort', () => {
  it('holds the port until release and then allows the target to bind it', async () => {
    const reservation = await reserveLoopbackPort('127.0.0.1');
    const blocked = createServer();
    await expect(new Promise<void>((resolve, reject) => {
      blocked.once('error', reject);
      blocked.listen(reservation.port, '127.0.0.1', () => resolve());
    })).rejects.toMatchObject({ code: 'EADDRINUSE' });

    await reservation.release();
    const target = createServer();
    await new Promise<void>((resolve, reject) => {
      target.once('error', reject);
      target.listen(reservation.port, '127.0.0.1', () => resolve());
    });
    await new Promise<void>((resolve, reject) => target.close((error) => error ? reject(error) : resolve()));
  });
});

describe('startDebugTarget', () => {
  it('streams output and terminates the exact host-owned process', async () => {
    let stdout = '';
    const target = await startDebugTarget({
      command: process.execPath,
      args: ['-e', "process.stdout.write('rea'); setTimeout(() => process.stdout.write('dy\\n'), 25); setInterval(() => {}, 1000)"],
      readyPattern: 'ready',
      readyTimeoutMs: 1_000,
    }, (category, output) => {
      if (category !== 'stdout') return;
      stdout += output;
    });

    await target.ready;
    expect(target.child.pid).toBeGreaterThan(0);
    await target.dispose();
    expect(stdout).toContain('ready');
    expect(target.child.exitCode !== null || target.child.signalCode !== null).toBe(true);
  });

  it('rejects readiness when the target exits before its marker', async () => {
    const target = await startDebugTarget({
      command: process.execPath,
      args: ['-e', 'process.exit(2)'],
      readyPattern: 'Ready on http://',
      readyTimeoutMs: 1_000,
    }, () => undefined);

    await expect(target.ready).rejects.toThrow('exited before becoming ready');
    await target.dispose();
  });

  it('materializes confined prepared files and removes them on dispose', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mcp-debug-target-'));
    const prepared = join(cwd, 'debug-entry.mjs');
    try {
      const target = await startDebugTarget({
        command: process.execPath,
        args: ['-e', "process.stdout.write('ready\\n'); setTimeout(() => process.exit(0), 50)"],
        cwd,
        preparedFiles: [{ path: prepared, content: 'export default {};\n' }],
        readyPattern: 'ready',
        readyTimeoutMs: 1_000,
      }, () => undefined);

      await target.ready;
      expect(readFileSync(prepared, 'utf8')).toBe('export default {};\n');
      await new Promise((resolve) => setTimeout(resolve, 150));
      await target.dispose();
      expect(existsSync(prepared)).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it('rejects prepared files outside the target cwd', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mcp-debug-target-'));
    try {
      await expect(startDebugTarget({
        command: process.execPath,
        cwd,
        preparedFiles: [{ path: join(cwd, '..', 'escape.mjs'), content: '' }],
      }, () => undefined)).rejects.toThrow('escapes cwd');
    } finally {
      rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
