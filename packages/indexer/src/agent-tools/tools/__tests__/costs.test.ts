import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import { CostTracker } from '@mcp/services/services/costs.js';
import { miscTools } from '../misc.js';
import type { IndexToolContext } from '../../context.js';

const cleanup: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); cleanup.splice(0).reverse().forEach(fn => fn()); });
const tool = miscTools.find(t => t.name === 'get_costs')!;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cost-summary-')), file = join(root, 'db.sqlite'), db = new CodeIndexDB(file);
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const project = db.createProject('cost-project', root), other = db.createProject('other-cost', root + '-other');
  const row = { projectId: project.id, provider: 'fixture', model: 'test', operation: 'embedding' as const, inputTokens: 20, outputTokens: 0, costUsd: 0.5 };
  db.insertCost(row); db.insertCost({ ...row, projectId: other.id, costUsd: 3 });
  const ctx = { db, costTracker: new CostTracker(db) } as IndexToolContext;
  return { root, file, db, project, row, ctx };
}
const read = async (ctx: IndexToolContext, args: Record<string, unknown> = {}) => {
  const result = await tool.handler(args, ctx); return JSON.parse(typeof result === 'string' ? result : result.text);
};

it('keeps summaries project-scoped and reuses a projection without rescanning unchanged ledger rows', async () => {
  const { db, ctx, project } = fixture(); const prepare = vi.spyOn(db.raw(), 'prepare');
  expect((await read(ctx, { project_name: project.name })).total_cost_usd).toBe(0.5);
  expect((await read(ctx)).total_cost_usd).toBe(3.5);
  prepare.mockClear();
  const result = db.getCostSummary(project.id); result.by_provider.fixture.cost_usd = 999;
  expect(db.getCostSummary(project.id).by_provider.fixture.cost_usd).toBe(0.5);
  expect(prepare.mock.calls.some(([sql]) => /FROM costs/i.test(sql))).toBe(false);
});

it('invalidates after own writes and another SQLite connection commits', async () => {
  const { db, file, ctx, project, row } = fixture();
  expect((await read(ctx, { project_name: project.name })).total_cost_usd).toBe(0.5);
  db.insertCost(row); expect((await read(ctx, { project_name: project.name })).total_cost_usd).toBe(1);
  const other = new CodeIndexDB(file);
  try { other.insertCost(row); expect((await read(ctx, { project_name: project.name })).total_cost_usd).toBe(1.5); }
  finally { other.close(); }
});

it('normalizes ISO timezone boundaries to the ledger UTC format without losing same-day costs', async () => {
  const { db, ctx, project } = fixture();
  db.raw().prepare('UPDATE costs SET created_at=?').run('2026-10-07 12:00:00');
  expect((await read(ctx, { project_name: project.name, since: '2026-10-07T09:00:00-03:00' })).total_cost_usd).toBe(0.5);
  expect((await read(ctx, { project_name: project.name, since: '2026-10-07T12:00:00.001Z' })).total_cost_usd).toBe(0);
  expect((await read(ctx, { since: '2026-10-07' })).total_cost_usd).toBe(3.5);
  for (const since of ['yesterday', '2026-02-30', '2026-13-01', '2026-10-07T12:00:00', 2]) {
    await expect(read(ctx, { since })).rejects.toThrow('valid ISO');
  }
});

it('rejects cancellation before touching the ledger', async () => {
  const { ctx, db } = fixture(); ctx.signal = AbortSignal.abort(new Error('attempt stopped'));
  const project = vi.spyOn(db, 'getCostSummary'), global = vi.spyOn(db, 'getGlobalCostSummary');
  await expect(read(ctx)).rejects.toThrow('attempt stopped'); expect(project).not.toHaveBeenCalled(); expect(global).not.toHaveBeenCalled();
});

it('does not retain a summary computed inside a rolled-back transaction', () => {
  const { db, project, row } = fixture();
  expect(db.getCostSummary(project.id).total_cost_usd).toBe(0.5);
  expect(() => db.raw().transaction(() => {
    db.insertCost(row); expect(db.getCostSummary(project.id).total_cost_usd).toBe(1);
    throw new Error('rollback');
  })()).toThrow('rollback');
  expect(db.getCostSummary(project.id).total_cost_usd).toBe(0.5);
});
