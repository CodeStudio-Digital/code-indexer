import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, renameSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFilesystemAdapter } from '@mcp/code-agent/ports/filesystem-port.js';
import { SnapshotRecorder, SnapshotRecordingFilesystemPort } from '@mcp/code-agent/ports/snapshot-recording-filesystem-port.js';
import { asSessionId, type SessionId } from '@mcp/session-storage';
import type { SessionSnapshotStorePort } from '@mcp/services/services/session-snapshot-port.js';
import { nativeFilesystemPort } from '../workers/native-filesystem-port.js';

const directories: string[] = [];
afterEach(() => { for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(beforeRecord: () => void = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'native-fs-port-')); directories.push(root);
  writeFileSync(join(root, 'source'), 'keep exact bytes');
  const record = vi.fn(async () => { beforeRecord(); return { baseline: { id: 'baseline' }, created: true }; });
  const complete = vi.fn(async () => ({ id: 'round' }));
  const recorder = new SnapshotRecorder({ projectRoot: root, sessionKind: 'coder',
    sessionId: asSessionId('00000000-0000-4000-8000-000000000001'), getRoundMessageId: () => 42,
    store: { recordBaselineAndEdit: record, recordRoundSnapshotMutation: complete } as unknown as SessionSnapshotStorePort<SessionId, string>,
  });
  return { root, record, complete, prepared: new SnapshotRecordingFilesystemPort(new LocalFilesystemAdapter(), recorder) };
}

it('retains snapshots and dispatches canonical relative paths under the current owner', async () => {
  const f = fixture(), assertCurrent = vi.fn();
  const rename = vi.fn((root: string, source: string, destination: string) => renameSync(join(root, source), join(root, destination)));
  const port = nativeFilesystemPort({ ...f, assertCurrent, rename });
  await port.renameNoReplace!(join(f.root, 'source'), join(f.root, 'target'));
  expect(rename).toHaveBeenCalledWith(f.root, 'source', 'target'); expect(assertCurrent).toHaveBeenCalledOnce();
  expect(f.record).toHaveBeenCalledTimes(2); expect(f.complete).toHaveBeenCalledTimes(2);
  expect(readFileSync(join(f.root, 'target'), 'utf8')).toBe('keep exact bytes'); expect(existsSync(join(f.root, 'source'))).toBe(false);
});

it('rechecks ownership after awaited snapshot capture before physical rename', async () => {
  let revoked = false; const f = fixture(() => { revoked = true; }); const rename = vi.fn();
  const port = nativeFilesystemPort({ ...f, rename, assertCurrent: () => { if (revoked) throw new Error('lease revoked'); } });
  await expect(port.renameNoReplace!(join(f.root, 'source'), join(f.root, 'target'))).rejects.toThrow('lease revoked');
  expect(rename).not.toHaveBeenCalled(); expect(f.complete).not.toHaveBeenCalled(); expect(existsSync(join(f.root, 'source'))).toBe(true);
});

it('refuses root escapes and an adapter without the prepared snapshot owner', async () => {
  const f = fixture(), rename = vi.fn();
  const port = nativeFilesystemPort({ ...f, rename, assertCurrent: () => {} });
  await expect(port.renameNoReplace!(join(f.root, 'source'), join(f.root, '..', 'escape'))).rejects.toThrow('within');
  expect(rename).not.toHaveBeenCalled();
  expect(() => nativeFilesystemPort({ ...f, prepared: new LocalFilesystemAdapter(), rename, assertCurrent: () => {} })).toThrow('snapshot owner');
});
