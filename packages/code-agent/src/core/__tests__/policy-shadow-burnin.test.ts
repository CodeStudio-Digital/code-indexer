/**
 * Fase 2.5 burn-in smoke — functional, NOT an efficacy claim (D-012).
 *
 * Drives the composed policy-shadow port through a small invocation matrix
 * (allow / plan-mode deny / conservative external) against a real migrated
 * SQLite and proves the burn-in loop is measurable: comparisons persisted,
 * agreementRate computable via agreementStats, durable evaluation_ms on every
 * row, zero refusals without ENFORCE, and no raw input leaking into tables.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { policyEngine255 } from '@mcp/store/migrations/255_policy_engine.js';
import { policyComparisonLatency256 } from '@mcp/store/migrations/256_policy_comparison_latency.js';
import { PolicyDecisionStore } from '@mcp/store/control-plane/index.js';
import { ToolRegistry } from '../registry.js';
import type { CoderTool } from '../tool.js';
import { createPolicyShadowPort } from '../policy-shadow-adapter.js';

type DB = InstanceType<typeof DatabaseConstructor>;

const FLAGS = [
  'CODER_POLICY_ENGINE_SHADOW',
  'CODER_CAPABILITY_CATALOG_SHADOW',
  'CODER_HOOK_BUS_V1',
  'CODER_RESOURCE_GRANTS',
  'CODER_POLICY_ENGINE_ENFORCE',
] as const;

const SENTINEL = 'SECRET-BURNIN-INPUT-VALUE';

let db: DB;
let previous: Record<string, string | undefined>;

function tool(overrides: Partial<CoderTool> & { name: string; source: CoderTool['source'] }): CoderTool {
  return {
    description: 'burn-in tool',
    parameters: { type: 'object', properties: {} },
    handler: async () => ({ content: 'ok' }) as never,
    ...overrides,
  } as CoderTool;
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE coder_sessions (id INTEGER PRIMARY KEY)');
  policyEngine255.up(db);
  policyComparisonLatency256.up(db);
  previous = Object.fromEntries(FLAGS.map((f) => [f, process.env[f]]));
  for (const f of FLAGS) delete process.env[f];
  process.env.CODER_POLICY_ENGINE_SHADOW = '1';
  process.env.CODER_CAPABILITY_CATALOG_SHADOW = '1';
});

afterEach(() => {
  db.close();
  for (const f of FLAGS) {
    if (previous[f] === undefined) delete process.env[f];
    else process.env[f] = previous[f];
  }
});

describe('policy shadow burn-in smoke', () => {
  it('runs the invocation matrix: persists comparisons, agreementRate 1.0, latency, no refusals, no raw input', async () => {
    const registry = new ToolRegistry();
    const readTool = tool({ name: 'read_file', source: 'native', mutates: false, riskLevel: 'read' });
    const editTool = tool({ name: 'edit_file', source: 'native', mutates: true, riskLevel: 'write' });
    const externalTool = tool({ name: 'mcp__mail__send', source: 'mcp_external' });
    registry.registerAll([readTool, editTool, externalTool]);

    // Plan mode WITHOUT approval: edit_file must be a deny on both sides
    // (legacy block / shadow deny) — an agreement in the allow-vs-block
    // dimension. read_file and the external tool are allows (no ENFORCE, no
    // legacy restriction in this fixture).
    const created = createPolicyShadowPort({
      db,
      registry,
      sessionContext: {
        getLegacyContext: () => ({ planMode: true, planApproved: false, taskScope: null }),
        background: false,
        sessionId: 'session:burnin',
        agentRunId: 'agent-run:burnin',
      },
      log: () => undefined,
    })!;
    expect(created).not.toBeNull();

    const matrix = [
      { tool: readTool, name: 'read_file' },
      { tool: editTool, name: 'edit_file' },
      { tool: externalTool, name: 'mcp__mail__send' },
    ];
    for (const [index, entry] of matrix.entries()) {
      const result = await created.port({
        tool: entry.tool,
        toolUseId: `tu:burnin:${index}`,
        toolName: entry.name,
        toolInput: { note: SENTINEL, index },
        turn: 1,
      });
      // Without ENFORCE the shadow NEVER refuses — even for the deny row.
      expect(result).toEqual({ refuse: false });
    }

    // ≥3 comparisons persisted, one per invocation.
    const decisions = new PolicyDecisionStore(db);
    const comparisons = decisions.listComparisons(10);
    expect(comparisons.length).toBe(3);

    // agreementRate = 1.0 — shadow and legacy agree on every row of the
    // matrix (allow/allow, block/deny, allow/allow).
    const stats = decisions.agreementStats();
    expect(stats.total).toBe(3);
    expect(stats.agreements).toBe(3);
    expect(stats.agreements / stats.total).toBe(1);
    expect(stats.critical).toBe(0);

    // Durable evaluation_ms on every comparison (numeric, non-negative).
    for (const row of comparisons) {
      expect(typeof row.evaluationMs).toBe('number');
      expect(row.evaluationMs!).toBeGreaterThanOrEqual(0);
    }

    // The deny row is the plan-mode edit: legacy block, shadow deny.
    const denyRow = comparisons.find((c) => c.shadowEffect === 'deny');
    expect(denyRow).toMatchObject({ legacyEffect: 'block', agreement: true });

    // Catalog flag on: resolved set once, descriptors for the 3 tools.
    const sets = db.prepare('SELECT COUNT(*) AS count FROM resolved_capability_sets').get() as { count: number };
    expect(sets.count).toBe(1);
    const descriptors = db.prepare('SELECT COUNT(*) AS count FROM capability_descriptors').get() as { count: number };
    expect(descriptors.count).toBe(3);

    // Privacy: the seeded sentinel never lands in any Fase 2 table.
    const dump = ['policy_decisions', 'policy_decision_comparisons', 'capability_descriptors', 'resolved_capability_sets']
      .map((table) => (db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>)
        .map((r) => JSON.stringify(r)).join('\n'))
      .join('\n');
    expect(dump).not.toContain(SENTINEL);
  });
});
