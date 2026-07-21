import { createServer } from 'node:net';
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
    let ready!: () => void;
    const sawReady = new Promise<void>((resolve) => { ready = resolve; });
    const target = await startDebugTarget({
      command: process.execPath,
      args: ['-e', "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"],
    }, (category, output) => {
      if (category !== 'stdout') return;
      stdout += output;
      if (stdout.includes('ready')) ready();
    });

    await sawReady;
    expect(target.child.pid).toBeGreaterThan(0);
    await target.dispose();
    expect(stdout).toContain('ready');
    expect(target.child.exitCode !== null || target.child.signalCode !== null).toBe(true);
  });
});
