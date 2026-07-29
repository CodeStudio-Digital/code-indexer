import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  REQUIRED_BUNDLE_DIRECTORIES,
  commitStagingBundle,
} from '../bundles.js';
import { fileHash } from '../fs-ops.js';
import type { BundlePlan, MigrationFile } from '../model.js';
import { verifyBundle } from '../verify.js';

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function makeStagingBundle(): {
  root: string;
  plan: BundlePlan;
  fingerprint: string;
  entityPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'sessions-fs-bundle-'));
  cleanup.push(root);
  const uuid = randomUUID();
  const fingerprint = 'a'.repeat(64);
  const plan: BundlePlan = {
    identity: { kind: 'coder', id: 7 },
    uuid,
    scope: 'global',
    finalDir: join(root, uuid),
    stagingDir: join(root, `.migrating-${uuid}`),
  };
  mkdirSync(plan.stagingDir);
  for (const directory of REQUIRED_BUNDLE_DIRECTORIES) {
    mkdirSync(join(plan.stagingDir, ...directory.split('/')), { recursive: true });
  }
  writeJson(join(plan.stagingDir, 'session.json'), {
    schema_version: 1,
    id: uuid,
    kind: 'coder',
  });
  writeJson(join(plan.stagingDir, 'state.json'), { schema_version: 1, status: 'idle' });
  writeFileSync(join(plan.stagingDir, 'conversation.jsonl'), '', 'utf8');
  writeJson(join(plan.stagingDir, 'metrics', 'summary.json'), {
    schema_version: 1,
    updated_at: '2026-01-01T00:00:00.000Z',
    turns: 0,
    tool_calls: 0,
    provider_attempts: 0,
    tokens: {
      input: 0,
      output: 0,
      cache_read: 0,
      cache_creation: 0,
    },
  });
  const entityPath = join(plan.stagingDir, 'events', 'entity.json');
  writeJson(entityPath, { schema_version: 1, value: 'preserved' });
  const hashPaths = [
    join(plan.stagingDir, 'session.json'),
    join(plan.stagingDir, 'state.json'),
    join(plan.stagingDir, 'conversation.jsonl'),
    join(plan.stagingDir, 'metrics', 'summary.json'),
    entityPath,
  ];
  const hashes = Object.fromEntries(hashPaths.map((path) => [
    relative(plan.stagingDir, path).replace(/\\/g, '/'),
    fileHash(path),
  ]));
  writeJson(join(plan.stagingDir, 'migration.json'), {
    format_version: 1,
    layout_version: 1,
    source_db_fingerprint: fingerprint,
    legacy: plan.identity,
    session_uuid: uuid,
    phase: 'staging',
    created_at: new Date().toISOString(),
    counts: { coder_sessions: 1 },
    hashes,
    unavailable_artifacts: [],
  } satisfies MigrationFile);
  return { root, plan, fingerprint, entityPath };
}

describe('bundle commit and full-file integrity', () => {
  it('durably promotes the marker only after the directory rename', () => {
    const { plan, fingerprint } = makeStagingBundle();
    verifyBundle(plan.stagingDir, plan.uuid, fingerprint, 'staging');

    commitStagingBundle(plan, fingerprint);

    const marker = JSON.parse(
      readFileSync(join(plan.finalDir, 'migration.json'), 'utf8'),
    ) as MigrationFile;
    expect(marker.phase).toBe('committed');
    expect(marker.committed_at).toBeTruthy();
    expect(() => verifyBundle(
      plan.finalDir,
      plan.uuid,
      fingerprint,
      'committed',
    )).not.toThrow();
  });

  it('detects tampering in generic entity JSON, not only top-level files', () => {
    const { plan, fingerprint, entityPath } = makeStagingBundle();
    writeJson(entityPath, { schema_version: 1, value: 'tampered' });
    expect(() => verifyBundle(
      plan.stagingDir,
      plan.uuid,
      fingerprint,
      'staging',
    )).toThrow('bundle file hash mismatch');
  });

  it('rejects an undeclared file even when every declared hash is valid', () => {
    const { plan, fingerprint } = makeStagingBundle();
    writeJson(join(plan.stagingDir, 'events', 'undeclared.json'), { value: 1 });
    expect(() => verifyBundle(
      plan.stagingDir,
      plan.uuid,
      fingerprint,
      'staging',
    )).toThrow('bundle hash manifest coverage mismatch');
  });

  it('rejects invalid UTF-8 even when it is in the unhashed migration marker', () => {
    const { plan, fingerprint } = makeStagingBundle();
    writeFileSync(
      join(plan.stagingDir, 'migration.json'),
      Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]),
    );
    expect(() => verifyBundle(
      plan.stagingDir,
      plan.uuid,
      fingerprint,
      'staging',
    )).toThrow('file is not valid UTF-8');
  });

  it('rejects a count marker that omits exported rows', () => {
    const { plan, fingerprint } = makeStagingBundle();
    const markerPath = join(plan.stagingDir, 'migration.json');
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as MigrationFile;
    marker.counts = {};
    writeJson(markerPath, marker);
    expect(() => verifyBundle(
      plan.stagingDir,
      plan.uuid,
      fingerprint,
      'staging',
    )).toThrow('count manifest omits exported rows');
  });

  it('rejects a bundle root symlink or junction before traversing it', () => {
    const { root, plan, fingerprint } = makeStagingBundle();
    const linkedBundle = join(root, 'linked-bundle');
    symlinkSync(
      plan.stagingDir,
      linkedBundle,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    expect(() => verifyBundle(
      linkedBundle,
      plan.uuid,
      fingerprint,
      'staging',
    )).toThrow('bundle directory is not a safe real directory');
  });

  it('rejects a required directory symlink or junction', () => {
    const { root, plan, fingerprint } = makeStagingBundle();
    const events = join(plan.stagingDir, 'events');
    const realEvents = join(root, 'real-events');
    renameSync(events, realEvents);
    symlinkSync(
      realEvents,
      events,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    expect(() => verifyBundle(
      plan.stagingDir,
      plan.uuid,
      fingerprint,
      'staging',
    )).toThrow('bundle directory is not a safe real directory');
  });
});
