import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import { SemanticStore } from '@mcp/store/semantic-store.js';
import { indexNavigationTools } from '../index-navigation.js';
import { projectTools } from '../projects.js';
import type { ToolContext } from '../../context.js';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).reverse().forEach(fn => fn()));
function fixture(count = 553) {
  const root = mkdtempSync(join(tmpdir(), 'index-nav-')), db = new CodeIndexDB(join(root, 'index.db'));
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const project = db.createProject('index-navigation', root), other = db.createProject('other', root + '-other');
  const row = (path: string) => ({ path, language: 'typescript', size: 10, lineCount: 1, contentHash: 'x' });
  const target = db.upsertFile(project.id, row('value.ts'));
  for (let i = 0; i < count; i++) {
    const path = `src/consumer-${String(i).padStart(4, '0')}.ts`, id = db.upsertFile(project.id, row(path));
    db.upsertFileDependencies(project.id, id, path, ['../value'], []);
  }
  db.upsertFile(project.id, row('package.json')); db.upsertFile(other.id, row('private-other.ts'));
  const ctx = { db, semanticStore: new SemanticStore(db.raw()) } as ToolContext;
  return { db, ctx, project, target, count };
}
const text = (result: Awaited<ReturnType<typeof indexNavigationTools[0]['handler']>>) => typeof result === 'string' ? result : result.text;

it('uses bounded SQL pages with stable ties and project isolation, without full row hydration', async () => {
  const { db, ctx, project } = fixture();
  const full = vi.spyOn(db, 'listFiles').mockImplementation(() => { throw new Error('full hydration forbidden'); });
  vi.spyOn(db, 'listSnapshots').mockImplementation(() => { throw new Error('snapshot hydration forbidden'); });
  const pulse = projectTools.find(t => t.name === 'get_project_pulse')!;
  const summary = JSON.parse(text(await pulse.handler({ project_name: project.name, format: 'json' }, ctx)));
  expect(summary.file_count).toBe(555); expect(summary.key_files[0]).toBe('package.json');
  expect(summary.top_directories).toEqual([{ path: 'src', files: 553 }, { path: '.', files: 2 }]);
  const tool = indexNavigationTools.find(t => t.name === 'get_recently_modified_files')!;
  const first = await tool.handler({ project_name: project.name, limit: 500 }, ctx);
  expect(first).toMatchObject({ sourceTruncations: [{ inputSize: 555, outputSize: 500, recoverable: true }] });
  const tail = text(await tool.handler({ project_name: project.name, limit: 500, offset: 500 }, ctx));
  expect(tail).toContain('value.ts'); expect(tail).not.toContain('Continue:'); expect(tail).not.toContain('private-other'); expect(full).not.toHaveBeenCalled();
});

it('recovers every reverse dependency without truncation or repeats', async () => {
  const { db, ctx, project } = fixture(); vi.spyOn(db, 'getDependents').mockImplementation(() => { throw new Error('unbounded query'); });
  const tool = indexNavigationTools.find(t => t.name === 'get_dependents')!;
  const first = text(await tool.handler({ project_name: project.name, file_path: 'value.ts', limit: 500 }, ctx));
  const tail = text(await tool.handler({ project_name: project.name, file_path: 'value.ts', limit: 500, offset: 500 }, ctx));
  expect(first).toContain('of 553'); expect(first).toContain('consumer-0499.ts'); expect(first).not.toContain('consumer-0500.ts');
  expect(tail).toContain('consumer-0552.ts'); expect(tail).not.toContain('consumer-0499.ts'); expect(tail).not.toContain('Continue:');
  const deps = indexNavigationTools.find(t => t.name === 'get_dependencies')!;
  expect(text(await deps.handler({ project_name: project.name, file_path: 'src/consumer-0000.ts' }, ctx))).toContain('../value → value.ts');
});

it('bounds noncompact overviews and omits listing on explicit zero without losing the recovery path', async () => {
  const { ctx, project } = fixture(); const overview = projectTools.find(t => t.name === 'get_project_overview')!;
  const args = { project_name: project.name };
  const first = await overview.handler(args, ctx);
  expect(first).toMatchObject({ sourceTruncations: [{ inputSize: 555, outputSize: 500 }] }); expect(text(first)).toContain('"offset":500');
  const tail = text(await overview.handler({ ...args, offset: 500 }, ctx)); expect(tail).toContain('value.ts'); expect(tail).toContain('Earlier pages:');
  const zero = await overview.handler({ ...args, max_files: 0 }, ctx); expect(zero).toMatchObject({ sourceTruncations: [{ outputSize: 0 }] }); expect(text(zero)).toContain('"max_files":50');
});

it('rejects invalid pages and cancellation before executing queries', async () => {
  const { db, ctx, project } = fixture(1); const tool = indexNavigationTools[0]; const reads = vi.spyOn(db, 'listAgentIndexFiles');
  for (const args of [{ limit: -1 }, { offset: 1.5 }]) await expect(Promise.resolve().then(() => tool.handler({ project_name: project.name, ...args }, ctx))).rejects.toThrow('integers');
  await expect(Promise.resolve().then(() => tool.handler({ project_name: project.name }, { ...ctx, signal: AbortSignal.abort(new Error('cancelled')) }))).rejects.toThrow('cancelled');
  expect(reads).not.toHaveBeenCalled();
});

it('invalidates small shape caches for writes on either connection and cannot be poisoned by a consumer', () => {
  const { db, project } = fixture(1), before = db.getAgentProjectShape(project.id);
  before.keyFiles.length = 0; before.topDirectories[0].files = 900;
  expect(db.getAgentProjectShape(project.id).keyFiles).toContain('package.json');
  const row = (path: string) => ({ path, language: 'typescript', size: 1, lineCount: 1, contentHash: path });
  db.upsertFile(project.id, row('docs/README.md'));
  expect(db.getAgentProjectShape(project.id).keyFiles).toContain('docs/README.md');
  const otherConnection = new CodeIndexDB(join(project.root_path, 'index.db'));
  try { otherConnection.upsertFile(project.id, row('docs/package.json')); } finally { otherConnection.close(); }
  expect(db.getAgentProjectShape(project.id).topDirectories).toContainEqual({ path: 'docs', files: 2 });
});

it('never caches a shape from an uncommitted transaction that can roll back', () => {
  const { db, project } = fixture(1);
  db.getAgentProjectShape(project.id);
  expect(() => db.raw().transaction(() => {
    db.upsertFile(project.id, { path: 'rollback.ts', language: 'typescript', size: 1, lineCount: 1, contentHash: 'x' });
    expect(db.getAgentProjectShape(project.id).keyFiles).toContain('rollback.ts');
    throw new Error('rollback');
  })()).toThrow('rollback');
  expect(db.getAgentProjectShape(project.id).keyFiles).not.toContain('rollback.ts');
});
