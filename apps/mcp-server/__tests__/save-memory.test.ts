import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { CodeIndexDB } from '@mcp/store/db.js';
import { AgentMemoryService } from '@mcp/services/memory/agent-memory-service.js';
import { snapshotTools } from '../tools/snapshots.js';
import type { ToolContext } from '../context.js';

const tool = snapshotTools.find(tool => tool.name === 'save_memory')!;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mcp-memory-save-'));
  const db = new CodeIndexDB(join(root, 'test.db'));
  const project = db.createProject('bounded', root);
  const service = new AgentMemoryService(db);
  const signal = new AbortController();
  const ctx = { db, agentMemoryService: service, signal: signal.signal } as ToolContext;
  const input = { project_name: project.name, title: 'bounded-memory-test', content: 'Prefer bounded reads.',
    category: 'convention', importance: 0.94, referenced_files: ['first.ts'] };
  return { db, project, service, signal, ctx, input, close() { db.close(); rmSync(root, { recursive: true, force: true }); } };
}
it('persists rich project metadata and preserves dependencies when enriching the same memory', async () => {
  const f = fixture();
  try {
    expect(await tool.handler(f.input, f.ctx)).toContain('created=1');
    expect(await tool.handler({ ...f.input, content: 'Prefer bounded reads. Yield after each page.', referenced_files: ['second.ts'] }, f.ctx)).toContain('merged=1');
    const rows = f.db.raw().prepare('SELECT * FROM agent_memory WHERE project_id = ? AND archived_at IS NULL').all(f.project.id) as any[];
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ type: 'convention', scope: 'project' });
    expect(rows[0].importance).toBeGreaterThanOrEqual(0.94);
    expect(JSON.parse(rows[0].referenced_files).map((file: any) => file.path)).toEqual(['first.ts', 'second.ts']);
  } finally { f.close(); }
});
it('aborts between dedupe and persistence and exposes invalid input as a tool failure', async () => {
  const f = fixture();
  try {
    await expect(tool.handler({ ...f.input, importance: -1 }, f.ctx)).rejects.toThrow('importance');
    vi.spyOn(f.service, 'search').mockImplementationOnce(async () => { f.signal.abort(new Error('cancelled')); return []; });
    await expect(tool.handler(f.input, f.ctx)).rejects.toThrow('cancelled');
    expect(f.db.raw().prepare('SELECT count(*) AS count FROM agent_memory').get()).toEqual({ count: 0 });
  } finally { f.close(); }
});
it('serializes concurrent dedupe and writes and drains a queued cancellation before another effect', async () => {
  const f = fixture();
  try {
    const results = await Promise.all(Array.from({ length: 8 }, () => tool.handler(f.input, f.ctx)));
    expect(results.filter(result => String(result).includes('created=1'))).toHaveLength(1);
    expect(f.db.raw().prepare('SELECT count(*) AS count FROM agent_memory WHERE archived_at IS NULL').get()).toEqual({ count: 1 });
    let release!: () => void;
    const owner = f.service.runMutationBatch(() => new Promise<void>(r => { release = r; }));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const cancelled = tool.handler({ ...f.input, title: 'must not persist' }, f.ctx);
    const rejection = expect(cancelled).rejects.toThrow('queued cancellation');
    f.signal.abort(new Error('queued cancellation')); release(); await owner; await rejection;
    expect(f.db.raw().prepare('SELECT count(*) AS count FROM agent_memory WHERE archived_at IS NULL').get()).toEqual({ count: 1 });
  } finally { f.close(); }
});
