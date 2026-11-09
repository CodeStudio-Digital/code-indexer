/** Deterministic state matrix; discovered capabilities are never executed. */
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { buildFindToolsTool } from '@mcp/code-agent/tools/find-tools.js';
import { buildCapabilityCatalogTool } from '@mcp/code-agent/tools/capability-catalog-tool.js';
import { toolProjectionReceipt } from '@mcp/code-agent/core/tool-projection.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';

const registry = new ToolRegistry();
const names = Array.from({ length: 40 }, (_, i) => `mcp__fixture__inspect_${String(i).padStart(3, '0')}`);
for (const name of names) registry.register({ name, description: `Inspect fixture ${name}`, source: 'mcp_external',
  parameters: { type: 'object', properties: { path: { type: 'string' } } }, handler: async () => { throw new Error('Unexpected capability execution'); } });
registry.seal();
const find = buildFindToolsTool(registry);
const catalog = buildCapabilityCatalogTool({ registry, skills: [], skillTemplateContext: {
  PROJECT_NAME: 'fixture', PROJECT_ROOT: 'D:/fixture', SESSION_ID: 'fixture', OS: 'win32', TIMESTAMP: new Date().toISOString(),
} });
const rows: unknown[] = [];
for (const name of names) for (const state of ['visible', 'hidden', 'blocked', 'budget', 'absent'] as const) {
  const promoted: string[] = [];
  const visible = new Set(state === 'visible' ? [name] : []);
  const query = state === 'absent' ? `nonexistent_${name}_xyz` : name;
  const ctx = { cwd: 'D:/fixture', projectName: 'fixture', runner: {
    activeTiers: new Set(['bootstrap']), visibleToolNames: visible,
    promoteTool: (value: string) => { promoted.push(value); return []; },
    discoveryState: (value: string) => ({ authorization: state === 'blocked' && value === name ? 'blocked' : 'requires_dispatch_validation', visible: visible.has(value) }),
  } } as unknown as ToolContext;
  const start = performance.now();
  const found = await find.handler({ query, limit: 5 }, ctx);
  const discovered = await catalog.handler({ op: 'search', query, limit: 5 }, ctx);
  const data = found.structuredData as { candidates: { name: string; authorization: string; visible: boolean }[]; activation: { requested: string[] } | null } | undefined;
  const items = JSON.parse(discovered.content).items as { name: string; authorization: string; visible: boolean }[];
  if (state === 'absent') {
    assert.ok(!data?.activation); assert.equal(promoted.length, 0);
    // Weak relatives can be shown without activation of an executable match.
  } else {
    assert.ok(data);
    assert.equal(data.candidates[0]?.name, name); assert.equal(items[0]?.name, name);
    assert.equal(data.candidates[0].authorization, state === 'blocked' ? 'blocked' : 'requires_dispatch_validation');
    assert.equal(items[0].authorization, data.candidates[0].authorization);
    assert.equal(promoted.length, state === 'hidden' || state === 'budget' ? 1 : 0);
  }
  const requested = data?.activation?.requested ?? [];
  const outgoing = new Set(state === 'hidden' ? requested : visible);
  const receipt = toolProjectionReceipt(requested, outgoing, new Set(state === 'blocked' ? [] : names), 'fixture-projection', 'fixture-catalog');
  assert.ok(receipt.confirmed.every(n => outgoing.has(n)));
  if (state === 'budget') assert.deepEqual(receipt.deferred, [{ name, reason: 'projection_budget' }]);
  rows.push({ name, state, elapsedMs: performance.now() - start, pass: true, activation: data?.activation, receipt });
}
mkdirSync('.tmp/agent-ide-reliability', { recursive: true });
writeFileSync('.tmp/agent-ide-reliability/discovery-state.json', JSON.stringify({ at: new Date().toISOString(), samples: rows.length,
  scope: 'real registry/find/catalog adapters and receipt over explicit outgoing set; assembly tests separately prove provider projection', rows }, null, 2));
console.log(`PASS ${rows.length} discovery states, blocked/absent activation and projection receipts`);
