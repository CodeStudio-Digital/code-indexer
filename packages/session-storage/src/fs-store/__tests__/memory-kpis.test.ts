import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFsSessionMemoryKpis } from '../memory-kpis.js';

const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('memory KPI incremental reads', () => {
  it('coalesces polling, reuses unchanged bundles and refreshes only changed signals', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memory-kpi-')); roots.push(root);
    const now = Date.now();
    const entries = await Promise.all([1, 2].map(async id => {
      const path = join(root, String(id)); await mkdir(join(path, 'events'), { recursive: true });
      await writeFile(join(path, 'conversation.jsonl'), '');
      return { location: { bundle_path: path }, session: { id: String(id), owner_project_id: 10,
        linked_projects: [], created_at: new Date(now - 1000).toISOString(), updated_at: new Date(now).toISOString() } };
    }));
    let changed = false;
    const store = {
      ensureCatalog: vi.fn(async () => undefined), catalog: { list: () => entries },
      listSessionEvents: vi.fn(async () => [{ created_at: new Date(now).toISOString(), payload: { projectId: 10, created: 1 } }]),
      listSessionToolCalls: vi.fn(() => { throw new Error('full transcript must never be read'); }),
      listSessionMemoryToolCalls: vi.fn(async () => [{ tool_name: changed ? 'mcp__search_memory' : 'mcp__save_memory', created_at: new Date(now).toISOString() }]),
    };
    vi.useFakeTimers({ toFake: ['Date'] });
    const [first, parallel] = await Promise.all([readFsSessionMemoryKpis(store as any, 10, { now }), readFsSessionMemoryKpis(store as any, 10, { now })]);
    expect(first).toEqual(parallel);
    expect(first).toMatchObject({ sessionsInWindow: 2, learnedSessions: 2, explicitCalls: { save_memory: 2 } });
    expect(store.listSessionMemoryToolCalls).toHaveBeenCalledTimes(2);
    vi.setSystemTime(now + 6000);
    await readFsSessionMemoryKpis(store as any, 10, { now });
    expect(store.listSessionEvents).toHaveBeenCalledTimes(2);
    changed = true;
    await utimes(join(entries[0]!.location.bundle_path, 'events'), new Date(now + 7000), new Date(now + 7000));
    vi.setSystemTime(now + 12_000);
    const updated = await readFsSessionMemoryKpis(store as any, 10, { now });
    expect(updated.explicitCalls).toEqual({ search_memory: 1, save_memory: 1 });
    expect(store.listSessionEvents).toHaveBeenCalledTimes(3);
    expect(store.listSessionToolCalls).not.toHaveBeenCalled();
  });
});
