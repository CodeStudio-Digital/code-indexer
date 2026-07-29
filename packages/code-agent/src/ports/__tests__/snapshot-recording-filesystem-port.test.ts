import { describe, expect, it, vi } from 'vitest';
import type {
  FilesystemReaddirOptions,
  IFilesystemPort,
  PortDirent,
  PortStats,
} from '../filesystem-port.js';
import {
  SnapshotRecorder,
  SnapshotRecordingFilesystemPort,
} from '../snapshot-recording-filesystem-port.js';
import type { SessionSnapshotStorePort } from '@mcp/services/services/session-snapshot-port.js';
import {
  asSessionId,
  newSessionId,
  type SessionId,
} from '@mcp/session-storage';

class MemoryFilesystem implements IFilesystemPort {
  readonly files = new Map<string, string>();
  failWrite = false;
  failRename = false;

  async writeFile(absPath: string, data: string): Promise<void> {
    if (this.failWrite) throw new Error('write failed');
    this.files.set(absPath, data);
  }

  async readFile(absPath: string): Promise<string> {
    const content = this.files.get(absPath);
    if (content == null) throw new Error('not found');
    return content;
  }

  async mkdir(): Promise<void> {}
  async access(absPath: string): Promise<void> {
    if (!this.files.has(absPath)) throw new Error('not found');
  }
  async readdir(_absPath: string, _options: FilesystemReaddirOptions): Promise<PortDirent[]> {
    return [];
  }
  async unlink(absPath: string): Promise<void> {
    if (!this.files.delete(absPath)) throw new Error('not found');
  }
  async stat(absPath: string): Promise<PortStats> {
    const content = this.files.get(absPath);
    if (content == null) throw new Error('not found');
    return { isDirectory: () => false, isFile: () => true, size: content.length };
  }
  async rename(oldAbsPath: string, newAbsPath: string): Promise<void> {
    if (this.failRename) throw new Error('rename failed');
    const content = await this.readFile(oldAbsPath);
    this.files.delete(oldAbsPath);
    this.files.set(newAbsPath, content);
  }
  async rm(absPath: string): Promise<void> {
    this.files.delete(absPath);
  }
}

function harness(secondaryRoots?: ReadonlyArray<{ projectId: number; rootPath: string }>) {
  const sessionId = asSessionId('00000000-0000-4000-8000-000000000001');
  const baselineId = newSessionId();
  const roundSnapshotId = newSessionId();
  const recordBaselineAndEdit = vi.fn(() => ({
    baseline: { id: baselineId },
    created: true,
  }));
  const recordRoundSnapshotMutation = vi.fn(() => ({ id: roundSnapshotId }));
  const store = {
    recordBaselineAndEdit,
    recordRoundSnapshotMutation,
  } as unknown as SessionSnapshotStorePort<SessionId, string>;
  const onRecorded = vi.fn();
  const inner = new MemoryFilesystem();
  const recorder = new SnapshotRecorder({
    sessionKind: 'coder',
    sessionId,
    projectId: 10,
    projectRoot: 'C:\\repo',
    secondaryRoots,
    store,
    getTurn: () => 3,
    getRoundMessageId: () => 42,
    onRecorded,
  });
  const fs = new SnapshotRecordingFilesystemPort(inner, recorder);
  return {
    fs,
    inner,
    recordBaselineAndEdit,
    recordRoundSnapshotMutation,
    onRecorded,
    baselineId,
    roundSnapshotId,
  };
}

describe('SnapshotRecordingFilesystemPort round snapshots', () => {
  it('commits the round envelope and emits all snapshot identities after a successful write', async () => {
    const {
      fs,
      inner,
      recordRoundSnapshotMutation,
      onRecorded,
      baselineId,
      roundSnapshotId,
    } = harness();
    inner.files.set('C:\\repo\\a.ts', 'before\n');

    await fs.writeFile('C:\\repo\\a.ts', 'after\n');

    expect(recordRoundSnapshotMutation).toHaveBeenCalledWith(expect.objectContaining({
      round_message_id: 42,
      global_baseline_id: baselineId,
      project_id: 10,
      file_path: 'a.ts',
      content_before: 'before\n',
      content_after: 'after\n',
    }));
    expect(onRecorded).toHaveBeenCalledWith({
      baselineId,
      globalBaselineId: baselineId,
      roundMessageId: 42,
      roundSnapshotId,
      filePath: 'a.ts',
    });
  });

  it('does not commit or notify a round when the filesystem write fails', async () => {
    const { fs, inner, recordBaselineAndEdit, recordRoundSnapshotMutation, onRecorded } = harness();
    inner.files.set('C:\\repo\\a.ts', 'before\n');
    inner.failWrite = true;

    await expect(fs.writeFile('C:\\repo\\a.ts', 'after\n')).rejects.toThrow('write failed');

    expect(recordBaselineAndEdit).toHaveBeenCalledOnce();
    expect(recordRoundSnapshotMutation).not.toHaveBeenCalled();
    expect(onRecorded).not.toHaveBeenCalled();
  });

  it('disables both global and round hunk views when the new content is binary-like', async () => {
    const { fs, inner, recordBaselineAndEdit, recordRoundSnapshotMutation } = harness();
    inner.files.set('C:\\repo\\a.ts', 'before\n');

    await fs.writeFile('C:\\repo\\a.ts', `binary${String.fromCharCode(0)}content`);

    expect(recordBaselineAndEdit).toHaveBeenCalledWith(
      expect.objectContaining({ oversized: true, rollback_content: 'before\n' }),
      expect.anything(),
    );
    expect(recordRoundSnapshotMutation).toHaveBeenCalledWith(
      expect.objectContaining({ oversized: true }),
    );
  });

  it('records an authorized external root in the negative filesystem-root id namespace', async () => {
    const { fs, inner, recordBaselineAndEdit } = harness([
      { projectId: -7, rootPath: 'C:\\external' },
    ]);
    inner.files.set('C:\\external\\src\\a.ts', 'before\n');

    await fs.writeFile('C:\\external\\src\\a.ts', 'after\n');

    expect(recordBaselineAndEdit).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: -7, file_path: 'src/a.ts' }),
      expect.anything(),
    );
  });

  it('does not treat a sibling path sharing the root prefix as project-owned', async () => {
    const { fs, inner, recordBaselineAndEdit } = harness();
    inner.files.set('C:\\repository\\a.ts', 'before\n');

    await fs.writeFile('C:\\repository\\a.ts', 'after\n');

    expect(recordBaselineAndEdit).not.toHaveBeenCalled();
  });

  it('commits both sides of a rename only after the rename succeeds', async () => {
    const failed = harness();
    failed.inner.files.set('C:\\repo\\old.ts', 'content\n');
    failed.inner.failRename = true;
    await expect(failed.fs.rename('C:\\repo\\old.ts', 'C:\\repo\\new.ts'))
      .rejects.toThrow('rename failed');
    expect(failed.recordRoundSnapshotMutation).not.toHaveBeenCalled();

    const successful = harness();
    successful.inner.files.set('C:\\repo\\old.ts', 'content\n');
    await successful.fs.rename('C:\\repo\\old.ts', 'C:\\repo\\new.ts');
    expect(successful.recordRoundSnapshotMutation).toHaveBeenCalledTimes(2);
    expect(successful.recordRoundSnapshotMutation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ file_path: 'old.ts', existed_after: false }),
    );
    expect(successful.recordRoundSnapshotMutation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ file_path: 'new.ts', existed_before: false, content_after: 'content\n' }),
    );
  });
});
