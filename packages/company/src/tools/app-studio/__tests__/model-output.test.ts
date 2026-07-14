import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { normalizeAppSpec } from '@mcp/app-studio/spec/normalize.js';
import { serializeAppSpec } from '@mcp/app-studio/spec/types.js';
import type { AppSpec } from '@mcp/app-studio/spec/types.js';
import { appGetDbAssets } from '../app-get-db-assets.js';
import { appGetArchitecture } from '../app-get-architecture.js';
import { appGetSpec } from '../app-get-spec.js';
import { appGetProductModel } from '../app-product.js';
import { appGetUx, appGetWireframe } from '../app-experience.js';
import { compactAudit, pageItems, viewArg } from '../model-output.js';
import { setAppStudioStore } from '../store-binding.js';

const cleanup: string[] = [];
afterEach(() => { setAppStudioStore(null); cleanup.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })); });

describe('App Studio progressive model output', () => {
  it('exposes focused views on each large artifact getter', () => {
    const binding = { resolveAppSession: () => null, describeBinding: () => 'test' };
    const expected = new Map([
      [appGetSpec(binding), ['summary', 'requirements', 'features', 'screens', 'database', 'behaviors', 'full']],
      [appGetProductModel(binding), ['summary', 'domains', 'capabilities', 'scenarios', 'decisions', 'research', 'candidate_spec', 'full']],
      [appGetArchitecture(binding), ['summary', 'modules', 'decisions', 'risks', 'sources', 'tdd', 'full']],
      [appGetUx(binding), ['summary', 'directions', 'tokens', 'references', 'full']],
      [appGetWireframe(binding), ['summary', 'flows', 'screens', 'tests', 'slices', 'checklist', 'full']],
    ]);
    for (const [tool, views] of expected) {
      const properties = tool.parameters.properties as Record<string, { enum?: string[] }>;
      expect(properties.view?.enum, tool.name).toEqual(views);
      expect(properties.offset, tool.name).toBeDefined();
      expect(properties.limit, tool.name).toBeDefined();
    }
  });

  it('filters stable ids before pagination', () => {
    expect(pageItems([{ id: 'a' }, { id: 'b' }, { id: 'c' }], { ids: ['b', 'c'], offset: 1, limit: 1 }, (item) => item.id)).toEqual({
      items: [{ id: 'c' }], page: { offset: 1, returned: 1, total: 2, more: false, next_offset: null },
    });
  });

  it('returns compact and full spec views', async () => {
    const spec = normalizeAppSpec({ v: 1, summary: 'Orders', audience: 'Shops', locale: 'en-US', features: ['Track orders'], screens: [{ name: 'OrdersScreen', label: 'Orders', description: 'Manage orders' }], database: { required: true, entities: [{ name: 'orders', fields: ['id'] }] }, auth: { enabled: false, methods: [] }, design: { tone: 'Clear' } }) as AppSpec;
    if (!spec) throw new Error('fixture normalization failed');
    setAppStudioStore({} as never);
    const tool = appGetSpec({ resolveAppSession: () => ({ id: 9, spec_json: serializeAppSpec(spec) }) as never, describeBinding: () => 'test' });
    const summary = await tool.handler({}, { cwd: process.cwd(), projectName: 'test' } as ToolContext);
    expect(summary.structuredData).toMatchObject({ view: 'summary', counts: { features: 1, screens: 1, entities: 1 } });
    const full = await tool.handler({ view: 'full' }, { cwd: process.cwd(), projectName: 'test' } as ToolContext);
    expect(full.structuredData).toEqual(spec);
  });

  it('compacts score-based audits', () => {
    expect(viewArg({ view: 'surprise' }, ['summary', 'full'], 'summary')).toBe('summary');
    expect(compactAudit({ score: 90, issues: [{ severity: 'warning', id: 'w' }] })).toMatchObject({ ok: true, issue_count: 1 });
  });

  it('omits SQL until explicitly requested', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'app-assets-')); cleanup.push(cwd);
    mkdirSync(join(cwd, 'migrations')); mkdirSync(join(cwd, 'seeds'));
    writeFileSync(join(cwd, 'migrations', '0001_init.sql'), 'CREATE TABLE secret_table (id INTEGER);');
    writeFileSync(join(cwd, 'seeds', 'seed.sql'), 'INSERT INTO secret_table VALUES (8675309);');
    setAppStudioStore({} as never);
    const tool = appGetDbAssets({ resolveAppSession: () => ({ id: 7 }) as never, describeBinding: () => 'test' });
    const ctx = { cwd, projectName: 'test' } as ToolContext;
    expect((await tool.handler({}, ctx)).content).not.toContain('8675309');
    expect((await tool.handler({ include_seed: true, migration: '0001_init.sql' }, ctx)).content).toContain('8675309');
  });
});
