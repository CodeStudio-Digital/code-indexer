/**
 * Input-sensitive tools in a read-only session: `db_query` stays in the
 * session authority, and each call is classified by its own `riskOf` at the
 * policy gate — reads run, writes and DDL are refused, at the top level and
 * nested in code_exec. Runs through a real CoderRunner (bridge toolGate +
 * code_exec preflight), with only the database handler stubbed.
 */
import { describe, expect, it, vi } from 'vitest';
import { CoderRunner } from '../runner.js';
import { ToolRegistry } from '../registry.js';
import type { CoderTool } from '../tool.js';
import type { ChatProvider, ChatRequest } from '../../providers/adapter.js';
import { evaluateToolInvocation } from '../policy.js';
import { dbTools } from '../../tools/db/index.js';
import { buildCodeExecTool } from '../../tools/code-exec.js';

type Call = { id: string; name: string; input: Record<string, unknown> };
const nested = (sql: string) => `try { await tools.db_query({ sql: ${JSON.stringify(sql)} }); return 'ran'; }
catch (e) { return 'refused: ' + String(e && e.message ? e.message : e); }`;

function provider(calls: Call[]): ChatProvider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return { name: 'stub', model: 'stub-1', requests, setModel() {}, async *chat(request) {
    requests.push(request);
    if (requests.length === 1) {
      for (const call of calls) yield { type: 'tool_call_end', ...call };
    } else {
      yield { type: 'text_delta', text: 'done' };
    }
    yield { type: 'usage', usage: { input_tokens: 1, output_tokens: 1 } };
    yield { type: 'done' };
  } };
}

async function run(agentId: 'explore' | 'build', calls: Call[]) {
  const executed: string[] = [];
  const real = dbTools.find(tool => tool.name === 'db_query')!;
  const registry = new ToolRegistry();
  registry.register({ ...real, handler: vi.fn(async (args) => {
    executed.push(String(args.sql));
    return { content: 'rows' };
  }) });
  registry.register(buildCodeExecTool(registry));
  const runner = new CoderRunner({ provider: provider(calls), registry, systemPrompt: 'sys', agentId,
    toolContext: { cwd: process.cwd(), projectName: 'read-only-risk' },
    initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }] });
  const results = new Map<string, string>();
  runner.on('tool_call_result', (id, _name, result) => results.set(id, String(result.content)));
  await runner.run();
  return { executed, results };
}

const SELECT = 'SELECT id FROM users';
const WRITES = ['INSERT INTO users (id) VALUES (1)', 'UPDATE users SET id = 2', 'DROP TABLE users'];

describe('read-only session and input-sensitive tools', () => {
  it('runs read calls and refuses write/DDL calls at the top level and inside code_exec', async () => {
    const calls: Call[] = [
      { id: 'top-select', name: 'db_query', input: { sql: SELECT } },
      ...WRITES.map((sql, i) => ({ id: `top-write-${i}`, name: 'db_query', input: { sql } })),
      { id: 'nested-select', name: 'code_exec', input: { code: nested(SELECT) } },
      ...WRITES.map((sql, i) => ({ id: `nested-write-${i}`, name: 'code_exec', input: { code: nested(sql) } })),
    ];
    const { executed, results } = await run('explore', calls);
    expect(executed).toEqual([SELECT, SELECT]);
    expect(results.get('nested-select')).toContain('ran');
    WRITES.forEach((_sql, i) => {
      expect(results.get(`top-write-${i}`)).toContain('read-only');
      expect(results.get(`nested-write-${i}`)).toContain('refused');
      expect(results.get(`nested-write-${i}`)).toContain('read-only');
    });
  });

  it('leaves every call to the Build agent unrestricted', async () => {
    const { executed } = await run('build', WRITES.map((sql, i) => ({ id: `w${i}`, name: 'db_query', input: { sql } })));
    expect(executed).toEqual(WRITES);
  });

  it('fails closed when the classifier throws or returns an unknown level', () => {
    const ctx = { planMode: false, planApproved: false, taskScope: null, readOnly: true };
    const tool = (riskOf: CoderTool['riskOf']): CoderTool => ({ name: 'probe', source: 'native', description: 'probe',
      parameters: { type: 'object', properties: {} }, mutates: true, riskLevel: 'write', riskOf,
      handler: async () => ({ content: '' }) });
    expect(evaluateToolInvocation(tool(() => { throw new Error('boom'); }), {}, ctx)).toMatchObject({ allowed: false, reason: 'read_only' });
    expect(evaluateToolInvocation(tool(() => 'bogus' as never), {}, ctx)).toMatchObject({ allowed: false, reason: 'read_only' });
    expect(evaluateToolInvocation(tool(() => 'read'), {}, ctx).allowed).toBe(true);
  });
});
