import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LocalProcessManager,
} from '../core/sandbox/local-process/LocalProcessManager.js';
import { PortAllocator } from '../core/sandbox/port-allocator.js';
import { httpReadinessProbe } from '../core/sandbox/local-process/readiness-probe.js';
import type { SandboxEvent } from '../core/sandbox/types.js';

describe('httpReadinessProbe', () => {
  it('returns ok:true once a server starts answering', async () => {
    const allocator = new PortAllocator({ min: 45_200, max: 45_205, cooldownMs: 0 });
    const port = await allocator.acquire();
    const server = createServer((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    try {
      const probe = await httpReadinessProbe({ port, timeoutMs: 2_000, intervalMs: 50 });
      expect(probe.ok).toBe(true);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      allocator.release(port);
    }
  });

  it('returns ok:false with reason=timeout when nothing binds', async () => {
    const allocator = new PortAllocator({ min: 45_210, max: 45_212, cooldownMs: 0 });
    const port = await allocator.acquire();
    const probe = await httpReadinessProbe({ port, timeoutMs: 300, intervalMs: 50 });
    expect(probe).toEqual({ ok: false, reason: 'timeout' });
    allocator.release(port);
  });

  it('returns ok:false with reason=aborted on signal', async () => {
    const allocator = new PortAllocator({ min: 45_220, max: 45_222, cooldownMs: 0 });
    const port = await allocator.acquire();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const probe = await httpReadinessProbe({
      port,
      timeoutMs: 5_000,
      intervalMs: 50,
      signal: ac.signal,
    });
    expect(probe.ok).toBe(false);
    allocator.release(port);
  });
});

describe('LocalProcessManager', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'mcp-lpm-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('starts a node script, probes readiness, emits events, then stops', async () => {
    // Tiny node HTTP server that honors PORT. Written to disk and launched
    // via `node <file>` — exercises the full spawn → probe → ready path.
    const serverJs = join(tmpRoot, 'server.js');
    writeFileSync(
      serverJs,
      [
        "const http = require('node:http');",
        "const port = Number(process.env.PORT);",
        'const s = http.createServer((_req, res) => { res.end("ok"); });',
        's.listen(port, "127.0.0.1");',
      ].join('\n'),
    );

    const allocator = new PortAllocator({ min: 45_300, max: 45_310, cooldownMs: 0 });
    const mgr = new LocalProcessManager({ allocator });
    const events: SandboxEvent[] = [];
    const unsub = mgr.subscribe((e) => events.push(e));

    const result = await mgr.start({
      sessionId: 'test-1',
      cwd: tmpRoot,
      manifestKind: 'node',
      program: 'node',
      args: ['server.js'],
      env: {},
      rationale: 'test',
      synthSource: 'fallback',
      readinessTimeoutMs: 8_000,
    });

    expect(result.pid).toBeGreaterThan(0);
    expect(result.previewUrl).toBe('/preview/test-1/');
    expect(result.hostPort).toBeGreaterThanOrEqual(45_300);
    expect(result.hostPort).toBeLessThanOrEqual(45_310);

    // Verify event sequence surfaced to subscribers.
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('provisioning');
    expect(kinds).toContain('step');
    expect(kinds).toContain('ready');

    // Record is live in the manager.
    const live = mgr.get('test-1');
    expect(live?.status).toBe('running');
    expect(live?.hostPort).toBe(result.hostPort);

    // Stop it cleanly.
    await mgr.stop('test-1', 'test-teardown');
    expect(mgr.get('test-1')).toBeUndefined();
    expect(events.some((e) => e.kind === 'destroyed')).toBe(true);

    // Port returned to pool (cooldown=0 so we can re-acquire).
    const reacquired = await allocator.acquire();
    expect(reacquired).toBe(result.hostPort);
    allocator.release(reacquired);

    unsub();
  }, 20_000);

  it('fails with READINESS_FAILED when the child ignores PORT', async () => {
    // Node script that binds to a fixed port we did NOT allocate — the
    // readiness probe will poll the allocated port and time out.
    const serverJs = join(tmpRoot, 'server.js');
    writeFileSync(
      serverJs,
      [
        "const http = require('node:http');",
        'const s = http.createServer((_req, res) => { res.end("ok"); });',
        // Hardcode an unrelated port; the manager's probe target will never see traffic.
        's.listen(45_399, "127.0.0.1");',
      ].join('\n'),
    );

    const allocator = new PortAllocator({ min: 45_320, max: 45_325, cooldownMs: 0 });
    const mgr = new LocalProcessManager({ allocator });

    await expect(
      mgr.start({
        sessionId: 'test-2',
        cwd: tmpRoot,
        manifestKind: 'node',
        program: 'node',
        args: ['server.js'],
        env: {},
        rationale: 'hardcoded-port',
        synthSource: 'fallback',
        readinessTimeoutMs: 1_500,
      }),
    ).rejects.toThrow(/hardcoded port|did not respond/i);

    // After failure the session has no entry, port is released.
    expect(mgr.get('test-2')).toBeUndefined();
    const p = await allocator.acquire();
    expect(p).toBeGreaterThanOrEqual(45_320);
    allocator.release(p);
  }, 15_000);

  it('rejects starting a second process for the same session', async () => {
    const serverJs = join(tmpRoot, 'server.js');
    writeFileSync(
      serverJs,
      [
        "const http = require('node:http');",
        "const port = Number(process.env.PORT);",
        'http.createServer((_r, res) => { res.end("ok"); }).listen(port, "127.0.0.1");',
      ].join('\n'),
    );

    const allocator = new PortAllocator({ min: 45_340, max: 45_345, cooldownMs: 0 });
    const mgr = new LocalProcessManager({ allocator });

    await mgr.start({
      sessionId: 'dup',
      cwd: tmpRoot,
      manifestKind: 'node',
      program: 'node',
      args: ['server.js'],
      env: {},
      rationale: 't',
      synthSource: 'fallback',
      readinessTimeoutMs: 8_000,
    });

    await expect(
      mgr.start({
        sessionId: 'dup',
        cwd: tmpRoot,
        manifestKind: 'node',
        program: 'node',
        args: ['server.js'],
        env: {},
        rationale: 't',
        synthSource: 'fallback',
        readinessTimeoutMs: 8_000,
      }),
    ).rejects.toThrow(/already running/i);

    await mgr.stop('dup');
  }, 20_000);
});
