import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { normalizeAppSpec } from '@mcp/app-studio/spec/normalize.js';
import { serializeAppSpec } from '@mcp/app-studio/spec/types.js';
import { appGetDbAssets } from '../app-get-db-assets.js';
import { appGetArchitecture } from '../app-get-architecture.js';
import { appGetBuildPlan } from '../app-build-plan.js';
import { appGetSpec } from '../app-get-spec.js';
import { appGetStageBriefing, appGetProductModel } from '../app-product.js';
import { appGetUx, appGetWireframe } from '../app-experience.js';
import { compactAudit, pageItems, viewArg } from '../model-output.js';
import { setAppStudioStore } from '../store-binding.js';

const cleanup: string[] = [];

afterEach(() => {
  setAppStudioStore(null);
  cleanup.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

describe('App Studio progressive model output', () => {
  it('exposes summary, focused and full views on every large getter', () => {
    const binding = { resolveAppSession: () => null, describeBinding: () => 'test' };
    const expected = new Map([
      [appGetSpec(binding), ['summary', 'requirements', 'features', 'screens', 'database', 'behaviors', 'full']],
      [appGetProductModel(binding), ['summary', 'domains', 'capabilities', 'scenarios', 'decisions', 'research', 'candidate_spec', 'full']],
      [appGetStageBriefing(binding), ['summary', 'capabilities', 'scenarios', 'full']],
      [appGetArchitecture(binding), ['summary', 'modules', 'decisions', 'risks', 'sources', 'tdd', 'full']],
      [appGetUx(binding), ['summary', 'directions', 'tokens', 'references', 'full']],
      [appGetWireframe(binding), ['summary', 'flows', 'screens', 'tests', 'groups', 'tasks', 'full']],
      [appGetBuildPlan(binding), ['summary', 'current_group', 'groups', 'tasks', 'evidence', 'full']],
    ]);
    for (const [tool, views] of expected) {
      const properties = tool.parameters.properties as Record<string, { enum?: string[] }>;
      expect(properties.view?.enum, tool.name).toEqual(views);
      expect(properties.offset, tool.name).toBeDefined();
      expect(properties.limit, tool.name).toBeDefined();
    }
  });

  it('filters stable ids before bounded pagination and reports the next offset', () => {
    const result = pageItems(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
      { ids: ['b', 'c', 'd'], offset: 1, limit: 1 },
      (item) => item.id,
    );
    expect(result).toEqual({
      items: [{ id: 'c' }],
      page: { offset: 1, returned: 1, total: 3, more: true, next_offset: 2 },
    });
  });

  it('returns a compact spec summary by default and preserves the full canonical spec on request', async () => {
    const spec = normalizeAppSpec({
      v: 1,
      summary: 'Order manager for independent shops',
      audience: 'Shop owners',
      locale: 'en-US',
      features: ['Track orders', 'Notify customers'],
      screens: [
        { name: 'OrdersScreen', label: 'Orders', description: 'Manage current orders' },
        { name: 'CustomersScreen', label: 'Customers', description: 'Review customer history' },
      ],
      database: { required: true, entities: [{ name: 'orders', fields: ['id', 'status', 'customer_id'] }] },
      auth: { enabled: false, methods: [] },
      design: { tone: 'Clear and practical' },
    });
    if (!spec) throw new Error('fixture normalization failed');
    const session = { id: 9, spec_json: serializeAppSpec(spec) };
    setAppStudioStore({} as never);
    const tool = appGetSpec({ resolveAppSession: () => session as never, describeBinding: () => 'test' });

    const summary = await tool.handler({}, { cwd: process.cwd(), projectName: 'test' } as ToolContext);
    expect(summary.structuredData).toMatchObject({ view: 'summary', counts: { features: 2, screens: 2, entities: 1 } });
    expect(summary.content).not.toContain('OrdersScreen');

    const page = await tool.handler({ view: 'features', limit: 1 }, { cwd: process.cwd(), projectName: 'test' } as ToolContext);
    expect(page.structuredData).toMatchObject({ page: { returned: 1, total: 2, more: true, next_offset: 1 } });

    const full = await tool.handler({ view: 'full' }, { cwd: process.cwd(), projectName: 'test' } as ToolContext);
    expect(full.structuredData).toEqual(spec);
  });

  it('falls back to summary for unsupported views and compacts score-based audits', () => {
    expect(viewArg({ view: 'surprise' }, ['summary', 'full'], 'summary')).toBe('summary');
    expect(compactAudit({ score: 90, issues: [{ severity: 'warning', id: 'w' }] })).toEqual({
      ok: true,
      issue_count: 1,
      top_issues: [{ severity: 'warning', id: 'w' }],
    });
    expect(compactAudit({ score: 40, issues: [{ severity: 'error', id: 'e' }] })?.ok).toBe(false);
  });

  it('omits seed and migration SQL until explicitly requested', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'app-assets-'));
    cleanup.push(cwd);
    mkdirSync(join(cwd, 'migrations'));
    mkdirSync(join(cwd, 'seeds'));
    writeFileSync(join(cwd, 'migrations', '0001_init.sql'), 'CREATE TABLE secret_table (id INTEGER);');
    writeFileSync(join(cwd, 'seeds', 'seed.sql'), "INSERT INTO secret_table VALUES (8675309);");

    setAppStudioStore({} as never);
    const tool = appGetDbAssets({
      resolveAppSession: () => ({ id: 7 }) as never,
      describeBinding: () => 'test',
    });
    const ctx = { cwd, projectName: 'test' } as ToolContext;

    const summary = await tool.handler({}, ctx);
    expect(summary.contentFormat).toBe('markdown');
    expect(summary.content).not.toContain('8675309');
    expect(summary.content).not.toContain('CREATE TABLE secret_table');
    expect(JSON.stringify(summary.structuredData)).not.toContain('8675309');

    const full = await tool.handler({ include_seed: true, migration: '0001_init.sql' }, ctx);
    expect(full.content).toContain('8675309');
    expect(full.content).toContain('CREATE TABLE secret_table');
    expect(JSON.stringify(full.structuredData)).toContain('8675309');
  });
});
