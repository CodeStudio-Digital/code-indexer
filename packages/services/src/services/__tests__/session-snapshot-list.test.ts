import { describe, expect, it, vi } from 'vitest';
import type {
  BaselineRow,
  SessionSnapshotStorePort,
} from '../session-snapshot-port.js';
import { SessionSnapshotService } from '../session-snapshots.js';

function closedBaseline(id: string, filePath: string): BaselineRow {
  return {
    id,
    session_kind: 'coder',
    session_id: 'session-a',
    project_id: 7,
    file_path: filePath,
    content_before: 'before',
    rollback_content: 'before',
    existed_before: 1,
    baseline_hash: `hash-${id}`,
    oversized: 0,
    status: 'closed_kept',
    first_seen_at: '2026-01-01T00:00:00.000Z',
    last_edited_at: '2026-01-01T00:00:01.000Z',
    closed_at: '2026-01-01T00:00:02.000Z',
  };
}

describe('SessionSnapshotService.listFiles', () => {
  it('shares concurrent scans and resolves a project root once per scan', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rows = [
      closedBaseline('baseline-a', 'a.ts'),
      closedBaseline('baseline-b', 'b.ts'),
    ];
    const listBaselines = vi.fn(async () => {
      await gate;
      return rows;
    });
    const store = {
      listBaselines,
      listHunkDecisions: vi.fn(async () => []),
    } as unknown as SessionSnapshotStorePort;
    const resolveProjectRoot = vi.fn(async () => 'D:\\project');
    const service = new SessionSnapshotService(store, resolveProjectRoot);

    const first = service.listFiles('coder', 'session-a', {
      includeClosed: true,
    });
    const second = service.listFiles('coder', 'session-a', {
      includeClosed: true,
    });

    expect(listBaselines).toHaveBeenCalledOnce();
    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toEqual(secondResult);
    expect(firstResult.map((file) => file.filePath)).toEqual(['a.ts', 'b.ts']);
    expect(resolveProjectRoot).toHaveBeenCalledOnce();

    await service.listFiles('coder', 'session-a', { includeClosed: true });
    expect(listBaselines).toHaveBeenCalledTimes(2);
    expect(resolveProjectRoot).toHaveBeenCalledTimes(2);
  });
});
