import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { auditAppArchitecture } from '../architecture/audit.js';
import { readTddCycles, recordTddCycle } from '../architecture/tdd-cycles.js';
import { normalizeAppArchitecturePlan, type AppArchitecturePlan } from '../architecture/types.js';
import { makeSpec } from './fixtures.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function plan(): AppArchitecturePlan {
  const url = 'https://developers.cloudflare.com/workers/vite-plugin/';
  return {
    v: 1,
    spec_revision_id: 12,
    stack_profile_id: 'cf-fullstack-v1',
    summary: 'React talks to a Hono Worker that stores orders in D1.',
    modules: [
      { id: 'ui', name: 'Interface', layer: 'ui', responsibility: 'Shows and edits orders.', depends_on: ['api'] },
      { id: 'api', name: 'API', layer: 'worker', responsibility: 'Validates and persists orders.', depends_on: ['db'] },
      { id: 'db', name: 'Database', layer: 'data', responsibility: 'Stores orders.', depends_on: [] },
    ],
    decisions: [{ id: 'runtime', title: 'Runtime', decision: 'Use the managed Workers runtime.', rationale: 'Matches production locally.', source_urls: [url] }],
    data_flow: ['User -> React -> Hono -> D1'],
    security: ['Use bound parameters for every D1 query.'],
    observability: ['Keep Workers observability enabled.'],
    risks: [{ id: 'schema', title: 'Schema changes', mitigation: 'Use additive migrations.', severity: 'medium' }],
    sources: [{ title: 'Cloudflare Vite plugin', url, checked_at: '2026-07-09T00:00:00.000Z', notes: 'Confirms the production-like Workers runtime.' }],
    tdd: {
      strategy: 'Write a failing test for each contract, implement, then rerun it green.',
      cases: [{
        id: 'db-orders',
        title: 'Orders are stored',
        layer: 'database',
        owner_profile: 'data',
        priority: 'critical',
        source_ids: ['entity:pedidos'],
        preconditions: ['Empty local D1 database'],
        steps: ['Create an order', 'Read it back'],
        expected: 'The saved order is returned.',
      }],
    },
  };
}

describe('architecture audit', () => {
  it('normalizes recoverable provider omissions before auditing', () => {
    const normalized = normalizeAppArchitecturePlan({
      summary: 'Simple plan',
      modules: [{ id: 'api', name: 'API', responsibility: 'Serves data' }],
      decisions: [{ id: 'runtime', title: 'Runtime', decision: 'Workers', rationale: 'Managed runtime' }],
      sources: [],
      tdd: { strategy: 'Red then green', cases: [{ id: 'case', title: 'Case', expected: 'Works' }] },
    }, 9);
    expect(normalized.modules[0]).toMatchObject({ layer: 'cross-cutting', depends_on: [] });
    expect(normalized.decisions[0]?.source_urls).toEqual([]);
    expect(normalized.tdd.cases[0]).toMatchObject({ layer: 'worker', owner_profile: 'api', source_ids: [], steps: [] });
    expect(() => auditAppArchitecture(normalized, makeSpec())).not.toThrow();
  });

  it('accepts an official, fully traceable architecture plan', () => {
    expect(auditAppArchitecture(plan(), makeSpec())).toMatchObject({ ok: true, issues: [] });
  });

  it('rejects unofficial research and missing spec coverage', () => {
    const value = plan();
    value.sources[0]!.url = 'https://example.com/blog';
    value.decisions[0]!.source_urls = [value.sources[0]!.url];
    value.tdd.cases[0]!.source_ids = [];
    const report = auditAppArchitecture(value, makeSpec());
    expect(report.ok).toBe(false);
    expect(report.issues.join('\n')).toContain('not from an approved official documentation domain');
    expect(report.issues.join('\n')).toContain("No test covers spec item 'entity:pedidos'");
  });

});

describe('TDD cycle evidence', () => {
  it('records red and green timestamps per architecture case', () => {
    const root = mkdtempSync(join(tmpdir(), 'app-studio-tdd-'));
    roots.push(root);
    recordTddCycle(root, { caseIds: ['db-orders'], script: 'test:worker', phase: 'red', output: 'failed as expected' });
    recordTddCycle(root, { caseIds: ['db-orders'], script: 'test:worker', phase: 'green', output: 'passed' });
    const cycle = readTddCycles(root).cycles['db-orders'];
    expect(cycle?.red_at).toBeTruthy();
    expect(cycle?.green_at).toBeTruthy();
    expect(cycle?.last_output).toBe('passed');
  });
});
