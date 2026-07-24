import { describe, expect, it } from 'vitest';
import { resolve, sep } from 'node:path';
import {
  ResourceBindingError,
  bindResource,
  confinePath,
  revalidateBinding,
  type BindResourceInput,
} from '../resource-binding.js';
import type {
  ExecutionEnvironmentRef,
  ResourceBinding,
  WorkspaceLease,
} from '@mcp/agent-runtime-contracts';

const ROOT = resolve('/repo');

const ENV: ExecutionEnvironmentRef = {
  environmentId: 'env:1' as never,
  kind: 'worktree',
  status: 'ready',
  projectId: 'p1',
  rootRef: 'root:1',
  cwdRef: 'cwd:1',
  version: 3,
};

const LEASE: WorkspaceLease = {
  leaseId: 'lease:1' as never,
  environmentId: 'env:1' as never,
  ownerAgentRunId: 'run:1' as never,
  access: 'exclusive_write',
  status: 'active',
  rootRef: 'root:1',
  acquiredAt: '2026-01-01T00:00:00.000Z',
  cleanupPolicy: 'remove_if_clean',
  fencingEpoch: 7,
  version: 2,
};

function baseInput(overrides: Partial<BindResourceInput> = {}): BindResourceInput {
  return {
    bindingId: 'bind:1',
    effectiveInput: { path: 'src/a.ts' },
    resources: [{ kind: 'path', path: 'src/a.ts', access: 'write' }],
    authorizedRoot: ROOT,
    resolvedAt: '2026-01-01T00:00:00.000Z',
    ttlMs: 30_000,
    ...overrides,
  };
}

describe('confinePath', () => {
  it('confines a relative path to the authorized root', () => {
    expect(confinePath('src/a.ts', ROOT)).toBe(resolve(ROOT, 'src/a.ts'));
  });

  it('rejects traversal that escapes the root', () => {
    expect(() => confinePath('../../etc/passwd', ROOT)).toThrow(ResourceBindingError);
    expect(() => confinePath('src/../../outside', ROOT)).toThrow(/path_escape/);
  });

  it('rejects an absolute path outside the root', () => {
    expect(() => confinePath(resolve('/elsewhere/secret'), ROOT)).toThrow(/path_escape/);
  });
});

describe('bindResource', () => {
  it('classifies every resource kind into the discriminated union', () => {
    const binding = bindResource(baseInput({
      resources: [
        { kind: 'path', path: 'src/a.ts', access: 'write', followSymlinks: false },
        { kind: 'command', executable: 'git', argRules: ['status'] },
        { kind: 'network', domains: ['api.example.com'], methods: ['GET'] },
        { kind: 'database', databaseId: 'db1', operations: ['select'] },
        { kind: 'secret', secretIds: ['s1'], exposure: 'handle-only' },
        { kind: 'application', appId: 'app1', operations: ['read'] },
      ],
    }), ENV, LEASE);

    expect(binding.canonicalResources.map((r) => r.kind)).toEqual([
      'path', 'command', 'network', 'database', 'secret', 'application',
    ]);
    const pathConstraint = binding.canonicalResources[0];
    expect(pathConstraint).toMatchObject({ kind: 'path', access: 'write' });
    expect((pathConstraint as { root: string }).root.startsWith(ROOT + sep)).toBe(true);
  });

  it('stamps environment + lease versions and epoch, hashing the raw input (no secret leak)', () => {
    const binding = bindResource(baseInput({
      effectiveInput: { path: 'src/a.ts', secretToken: 'SECRET-RAW-INPUT' },
    }), ENV, LEASE);
    expect(binding.environmentVersion).toBe(3);
    expect(binding.workspaceLeaseVersion).toBe(2);
    expect(binding.workspaceFencingEpoch).toBe(7);
    expect(binding.effectiveInputHash).toMatch(/^[a-f0-9]{64}$/);
    // The raw effective input is hashed, never embedded. The canonical path
    // constraint (the resource itself) legitimately carries the path.
    expect(JSON.stringify(binding)).not.toContain('SECRET-RAW-INPUT');
  });

  it('fails closed on a traversal resource', () => {
    expect(() => bindResource(baseInput({
      resources: [{ kind: 'path', path: '../../etc/passwd', access: 'read' }],
    }), ENV)).toThrow(/path_escape/);
  });
});

describe('revalidateBinding', () => {
  const binding = (): ResourceBinding => bindResource(baseInput(), ENV, LEASE);

  it('passes when versions and epoch are unchanged and not expired', () => {
    expect(revalidateBinding(binding(), {
      environmentVersion: 3,
      workspaceLeaseVersion: 2,
      workspaceFencingEpoch: 7,
      now: '2026-01-01T00:00:10.000Z',
    })).toEqual({ ok: true });
  });

  it('fails closed when the environment version moved', () => {
    expect(revalidateBinding(binding(), {
      environmentVersion: 4,
      workspaceLeaseVersion: 2,
      workspaceFencingEpoch: 7,
      now: '2026-01-01T00:00:10.000Z',
    })).toEqual({ ok: false, reasonCode: 'environment_changed' });
  });

  it('fails closed when the lease version or fencing epoch moved', () => {
    expect(revalidateBinding(binding(), {
      environmentVersion: 3,
      workspaceLeaseVersion: 3,
      workspaceFencingEpoch: 7,
      now: '2026-01-01T00:00:10.000Z',
    })).toEqual({ ok: false, reasonCode: 'lease_changed' });
    expect(revalidateBinding(binding(), {
      environmentVersion: 3,
      workspaceLeaseVersion: 2,
      workspaceFencingEpoch: 8,
      now: '2026-01-01T00:00:10.000Z',
    })).toEqual({ ok: false, reasonCode: 'epoch_changed' });
  });

  it('fails closed when the binding has expired', () => {
    expect(revalidateBinding(binding(), {
      environmentVersion: 3,
      workspaceLeaseVersion: 2,
      workspaceFencingEpoch: 7,
      now: '2026-01-01T01:00:00.000Z',
    })).toEqual({ ok: false, reasonCode: 'expired' });
  });
});
