/**
 * Tests for the health extension of `CompanySandboxServicesStore`
 * (migration 188, company B1) — `updateHealth` + `bumpRestartCount`,
 * composed from `CompanySandboxServicesHealth`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '../db.js';
import { CompanySandboxServicesStore } from '../company-sandbox-services-store.js';

interface Handle {
  db: CodeIndexDB;
  store: CompanySandboxServicesStore;
  dir: string;
}

function setup(): Handle {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-svc-health-test-'));
  const db = new CodeIndexDB(join(dir, 'test.db'));
  // company_sandbox_services.session_id has an FK to company_sessions
  // (foreign_keys pragma is ON) — plant the parent row (id = 1).
  db.raw().prepare(`INSERT INTO company_sessions (name) VALUES ('health-test')`).run();
  return { db, store: new CompanySandboxServicesStore(db.raw()), dir };
}

function teardown(h: Handle): void {
  try { h.db.close(); } catch { /* */ }
  try { rmSync(h.dir, { recursive: true, force: true }); } catch { /* */ }
}

function plantService(h: Handle, serviceId = 'api', hostPort = 40_001): void {
  h.store.upsert({
    session_id: 1,
    service_id: serviceId,
    container_id: `ctr-${serviceId}`,
    runtime: 'docker',
    stack: 'react-ts',
    workdir: '/app',
    host_port: hostPort,
    limits: {},
    status: 'running',
  });
}

let h: Handle;
beforeEach(() => { h = setup(); });
afterEach(() => teardown(h));

describe('CompanySandboxServicesStore — health defaults (mig 188)', () => {
  it('seeds new rows with health=unknown and restart_count=0', () => {
    plantService(h);
    const row = h.store.get(1, 'api')!;
    expect(row.health).toBe('unknown');
    expect(row.health_detail).toBeNull();
    expect(row.last_health_at_ms).toBeNull();
    expect(row.restart_count).toBe(0);
  });
});

describe('CompanySandboxServicesStore — updateHealth', () => {
  it('writes health + detail + timestamp', () => {
    plantService(h);
    const ok = h.store.updateHealth(1, 'api', {
      health: 'unhealthy',
      healthDetail: 'HTTP 502 from probe',
      lastHealthAtMs: 12_345,
    });
    expect(ok).toBe(true);
    const row = h.store.get(1, 'api')!;
    expect(row.health).toBe('unhealthy');
    expect(row.health_detail).toBe('HTTP 502 from probe');
    expect(row.last_health_at_ms).toBe(12_345);
  });

  it('defaults lastHealthAtMs to now and detail to null', () => {
    plantService(h);
    const before = Date.now();
    h.store.updateHealth(1, 'api', { health: 'healthy' });
    const row = h.store.get(1, 'api')!;
    expect(row.health).toBe('healthy');
    expect(row.health_detail).toBeNull();
    expect(row.last_health_at_ms).toBeGreaterThanOrEqual(before);
  });

  it('clears a previous detail when a healthy probe omits it', () => {
    plantService(h);
    h.store.updateHealth(1, 'api', { health: 'unhealthy', healthDetail: 'boom' });
    h.store.updateHealth(1, 'api', { health: 'healthy' });
    expect(h.store.get(1, 'api')!.health_detail).toBeNull();
  });

  it('returns false when the (session, service) row does not exist', () => {
    expect(h.store.updateHealth(1, 'ghost', { health: 'healthy' })).toBe(false);
  });

  it('does not touch sibling services', () => {
    plantService(h, 'api', 40_001);
    plantService(h, 'frontend', 40_002);
    h.store.updateHealth(1, 'api', { health: 'unhealthy' });
    expect(h.store.get(1, 'frontend')!.health).toBe('unknown');
  });
});

describe('CompanySandboxServicesStore — bumpRestartCount', () => {
  it('increments and returns the new count', () => {
    plantService(h);
    expect(h.store.bumpRestartCount(1, 'api')).toBe(1);
    expect(h.store.bumpRestartCount(1, 'api')).toBe(2);
    expect(h.store.get(1, 'api')!.restart_count).toBe(2);
  });

  it('returns null when the row does not exist', () => {
    expect(h.store.bumpRestartCount(1, 'ghost')).toBeNull();
  });

  it('scopes the bump to the addressed service', () => {
    plantService(h, 'api', 40_001);
    plantService(h, 'frontend', 40_002);
    h.store.bumpRestartCount(1, 'api');
    expect(h.store.get(1, 'frontend')!.restart_count).toBe(0);
  });
});
