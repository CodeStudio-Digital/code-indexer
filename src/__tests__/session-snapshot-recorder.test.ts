import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FsSessionStore } from '@mcp/session-storage/fs-store/fs-session-store.js';
import { SessionSnapshotService } from '@mcp/services/services/session-snapshots.js';
import {
  SnapshotRecorder,
  SnapshotRecordingFilesystemPort,
} from '@mcp/code-agent/ports/snapshot-recording-filesystem-port.js';
import { LocalFilesystemAdapter } from '@mcp/code-agent/ports/filesystem-port.js';

async function setup() {
  const workDir = mkdtempSync(join(tmpdir(), 'sfs-recorder-'));
  const projectId = 7;
  const sessionStore = FsSessionStore.fromRoots({
    dataDir: join(workDir, 'data'),
    projectRootResolver: {
      resolveProjectRoot: (id) => id === projectId ? workDir : null,
      listProjectRoots: () => [
        { project_id: projectId, root_path: workDir },
      ],
    },
  });
  const session = await sessionStore.createSession({
    project_id: projectId,
    title: 'snap recorder',
    provider: 'zai',
    model: 'glm-5',
  });
  const snapshotStore = sessionStore;
  const inner = new LocalFilesystemAdapter();
  const recorder = new SnapshotRecorder({
    sessionKind: 'coder',
    sessionId: session.id,
    projectRoot: workDir,
    store: snapshotStore,
    getTurn: () => 1,
  });
  const fsPort = new SnapshotRecordingFilesystemPort(inner, recorder, 'write_file');
  const service = new SessionSnapshotService(
    snapshotStore,
    (kind, sid) =>
      kind === 'coder' && sid === session.id ? workDir : null,
  );
  return {
    workDir, sessionStore, snapshotStore, fsPort, recorder, session, service,
    cleanup: async () => {
      await sessionStore.close();
      rmSync(workDir, { recursive: true, force: true });
    },
  };
}

describe('SnapshotRecordingFilesystemPort', () => {
  it('captures the pre-edit content on first write to an existing file', async () => {
    const ctx = await setup();
    try {
      writeFileSync(join(ctx.workDir, 'a.txt'), 'baseline\n');
      await ctx.fsPort.writeFile(join(ctx.workDir, 'a.txt'), 'changed\n');
      const baselines = await ctx.snapshotStore.listBaselines('coder', ctx.session.id);
      expect(baselines).toHaveLength(1);
      expect(baselines[0].file_path).toBe('a.txt');
      expect(baselines[0].content_before).toBe('baseline\n');
      expect(baselines[0].existed_before).toBe(1);
      const files = await ctx.service.listFiles('coder', ctx.session.id);
      expect(files[0].pendingHunks).toBe(1);
    } finally {
      await ctx.cleanup();
    }
  });

  it('records existed_before=0 when the file is created during the session', async () => {
    const ctx = await setup();
    try {
      await ctx.fsPort.writeFile(join(ctx.workDir, 'new.txt'), 'hello\n');
      const baselines = await ctx.snapshotStore.listBaselines('coder', ctx.session.id);
      expect(baselines).toHaveLength(1);
      expect(baselines[0].existed_before).toBe(0);
      expect(baselines[0].content_before).toBeNull();
    } finally {
      await ctx.cleanup();
    }
  });

  it('is idempotent across multiple writes to the same file (one baseline, many edits)', async () => {
    const ctx = await setup();
    try {
      writeFileSync(join(ctx.workDir, 'b.txt'), 'v0\n');
      await ctx.fsPort.writeFile(join(ctx.workDir, 'b.txt'), 'v1\n');
      await ctx.fsPort.writeFile(join(ctx.workDir, 'b.txt'), 'v2\n');
      await ctx.fsPort.writeFile(join(ctx.workDir, 'b.txt'), 'v3\n');
      const baselines = await ctx.snapshotStore.listBaselines('coder', ctx.session.id);
      expect(baselines).toHaveLength(1);
      expect(baselines[0].content_before).toBe('v0\n');
      const edits = await ctx.snapshotStore.listEdits(baselines[0].id);
      expect(edits).toHaveLength(3);
    } finally {
      await ctx.cleanup();
    }
  });

  it('captures the pre-state on unlink so revertFile can restore the file', async () => {
    const ctx = await setup();
    try {
      writeFileSync(join(ctx.workDir, 'doomed.txt'), 'will be deleted\n');
      await ctx.fsPort.unlink(join(ctx.workDir, 'doomed.txt'));
      expect(existsSync(join(ctx.workDir, 'doomed.txt'))).toBe(false);
      const baselines = await ctx.snapshotStore.listBaselines('coder', ctx.session.id);
      const r = await ctx.service.revertFile(baselines[0].id);
      expect(r.ok).toBe(true);
      expect(existsSync(join(ctx.workDir, 'doomed.txt'))).toBe(true);
      expect(readFileSync(join(ctx.workDir, 'doomed.txt'), 'utf8')).toBe('will be deleted\n');
    } finally {
      await ctx.cleanup();
    }
  });

  it('revertHunk writes baseline lines back for that hunk and leaves the rest', async () => {
    const ctx = await setup();
    try {
      const baseline = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10'].join('\n') + '\n';
      const edited = ['a1', 'X2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'X10'].join('\n') + '\n';
      writeFileSync(join(ctx.workDir, 'c.txt'), baseline);
      await ctx.fsPort.writeFile(join(ctx.workDir, 'c.txt'), edited);
      const baselines = await ctx.snapshotStore.listBaselines('coder', ctx.session.id);
      const diff = await ctx.service.getDiff(baselines[0].id);
      expect(diff!.hunks.length).toBe(2);
      const r = await ctx.service.revertHunk(baselines[0].id, diff!.hunks[0].fingerprint);
      expect(r.ok).toBe(true);
      const after = readFileSync(join(ctx.workDir, 'c.txt'), 'utf8');
      // First hunk reverted → line 2 back to a2; line 10 still X10.
      expect(after).toBe(['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'X10'].join('\n') + '\n');
    } finally {
      await ctx.cleanup();
    }
  });

  it('acceptAll closes every active baseline as kept and leaves disk untouched', async () => {
    const ctx = await setup();
    try {
      writeFileSync(join(ctx.workDir, 'x.txt'), 'old\n');
      writeFileSync(join(ctx.workDir, 'y.txt'), 'old\n');
      await ctx.fsPort.writeFile(join(ctx.workDir, 'x.txt'), 'new-x\n');
      await ctx.fsPort.writeFile(join(ctx.workDir, 'y.txt'), 'new-y\n');
      const r = await ctx.service.acceptAll('coder', ctx.session.id);
      expect(r.closed).toBe(2);
      const active = await ctx.snapshotStore.listBaselines('coder', ctx.session.id);
      expect(active).toHaveLength(0);
      const all = await ctx.snapshotStore.listBaselines('coder', ctx.session.id, { includeClosed: true });
      expect(all.every((b) => b.status === 'closed_kept')).toBe(true);
      // On-disk content must reflect the latest write.
      expect(readFileSync(join(ctx.workDir, 'x.txt'), 'utf8')).toBe('new-x\n');
      expect(readFileSync(join(ctx.workDir, 'y.txt'), 'utf8')).toBe('new-y\n');
    } finally {
      await ctx.cleanup();
    }
  });

  it('treats a baseline whose path became a directory as missing content (no crash)', async () => {
    const ctx = await setup();
    try {
      const p = join(ctx.workDir, 'turned-dir');
      writeFileSync(p, 'was a file\n');
      await ctx.fsPort.writeFile(p, 'changed\n'); // records the baseline
      // The file is later replaced by a directory at the same path → reading
      // current content throws EISDIR, which must be swallowed (treated as null)
      // so the whole listing/diff doesn't crash.
      rmSync(p, { force: true });
      mkdirSync(p);
      const files = await ctx.service.listFiles('coder', ctx.session.id);
      const entry = files.find((f) => f.filePath === 'turned-dir');
      expect(entry).toBeDefined();
      const diff = await ctx.service.getDiff(entry!.baselineId);
      expect(diff).not.toBeNull();
    } finally {
      await ctx.cleanup();
    }
  });

  it('runUnrecorded bypasses the recorder (used internally by revert paths)', async () => {
    const ctx = await setup();
    try {
      writeFileSync(join(ctx.workDir, 'r.txt'), 'before\n');
      await ctx.fsPort.runUnrecorded(async (raw) => {
        await raw.writeFile(join(ctx.workDir, 'r.txt'), 'after\n');
      });
      const baselines = await ctx.snapshotStore.listBaselines('coder', ctx.session.id);
      expect(baselines).toHaveLength(0);
      expect(readFileSync(join(ctx.workDir, 'r.txt'), 'utf8')).toBe('after\n');
    } finally {
      await ctx.cleanup();
    }
  });
});
