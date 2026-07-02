/**
 * riskOf hook — per-input dynamic risk classification in the permission gate.
 * SELECT-ish inputs must ride free ('allow'); write-ish inputs must gate as
 * 'write' (pausing under mode 'ask'); tools WITHOUT riskOf must classify
 * exactly as before the hook existed.
 */
import { describe, expect, it, vi } from 'vitest';
import type { CoderTool } from '@mcp/code-agent/core/tool.js';
import { classifyForGate, PermissionGate } from '@mcp/code-agent/core/permission-gate.js';
import { dbTools } from '@mcp/code-agent/tools/db/index.js';

const byName = (name: string): CoderTool => {
  const t = dbTools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
};

const tool = (over: Partial<CoderTool>): CoderTool => ({
  name: 'x',
  description: 'd',
  parameters: { type: 'object', properties: {} },
  source: 'native',
  handler: async () => ({ content: '' }),
  ...over,
});

describe('classifyForGate + riskOf (db_query)', () => {
  const dbQuery = byName('db_query');

  it('SELECT → read → allow', () => {
    expect(classifyForGate(dbQuery, 'db_query', { sql: 'SELECT * FROM users LIMIT 5' })).toBe('allow');
    expect(classifyForGate(dbQuery, 'db_query', { sql: 'WITH x AS (SELECT 1) SELECT * FROM x' })).toBe('allow');
  });

  it('writes (and write-CTEs / missing sql) → write', () => {
    expect(classifyForGate(dbQuery, 'db_query', { sql: 'INSERT INTO t VALUES (1)' })).toBe('write');
    expect(classifyForGate(dbQuery, 'db_query', { sql: 'WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d' })).toBe('write');
    expect(classifyForGate(dbQuery, 'db_query', {})).toBe('write');
    expect(classifyForGate(dbQuery, 'db_query', undefined)).toBe('write');
  });

  it('db_command: read commands allow, writes/unknown gate as write', () => {
    const dbCommand = byName('db_command');
    expect(classifyForGate(dbCommand, 'db_command', { command: { op: 'find', collection: 'c' } })).toBe('allow');
    expect(classifyForGate(dbCommand, 'db_command', { command: { args: ['GET', 'k'] } })).toBe('allow');
    expect(classifyForGate(dbCommand, 'db_command', { command: { op: 'insertOne', collection: 'c' } })).toBe('write');
    expect(classifyForGate(dbCommand, 'db_command', { command: { args: ['FLUSHDB'] } })).toBe('write');
    expect(classifyForGate(dbCommand, 'db_command', {})).toBe('write');
  });

  it('a throwing riskOf fails safe as write', () => {
    const broken = tool({ name: 'boom', riskOf: () => { throw new Error('x'); } });
    expect(classifyForGate(broken, 'boom', {})).toBe('write');
  });

  it('fallback without riskOf is identical to the legacy chain', () => {
    // Representative rows from permission-gate.test.ts — must not change.
    expect(classifyForGate(tool({ name: 'write_file', mutates: true, riskLevel: 'write' }), 'write_file')).toBe('write');
    expect(classifyForGate(tool({ name: 'run_command' }), 'run_command')).toBe('execute');
    expect(classifyForGate(tool({ name: 'git_commit' }), 'git_commit')).toBe('admin');
    expect(classifyForGate(tool({ name: 'read_file' }), 'read_file')).toBe('allow');
    expect(classifyForGate(tool({ name: 'some_native_helper' }), 'some_native_helper')).toBe('allow');
    expect(classifyForGate(undefined, 'ghost_tool')).toBe('write');
    expect(classifyForGate(tool({ name: 'mcp__x__do_something', source: 'mcp_external' }), 'mcp__x__do_something')).toBe('write');
  });
});

describe('PermissionGate.check with riskOf under mode=ask', () => {
  const makeGate = (verdict: Record<string, unknown>) => {
    const emit = vi.fn();
    const waitForUserInput = vi.fn().mockResolvedValue(JSON.stringify(verdict));
    const gate = new PermissionGate({ getMode: () => 'ask', emit, waitForUserInput });
    return { gate, emit, waitForUserInput };
  };

  it('SELECT runs free — no approval round-trip', async () => {
    const { gate, emit, waitForUserInput } = makeGate({ approved: false });
    const r = await gate.check({
      toolUseId: 'tu1', toolName: 'db_query', tool: byName('db_query'),
      input: { sql: 'SELECT 1' },
    });
    expect(r.allowed).toBe(true);
    expect(emit).not.toHaveBeenCalled();
    expect(waitForUserInput).not.toHaveBeenCalled();
  });

  it('INSERT pauses as write; denial produces the user-denied refusal', async () => {
    const { gate, emit } = makeGate({ approved: false, note: 'não agora' });
    const r = await gate.check({
      toolUseId: 'tu2', toolName: 'db_query', tool: byName('db_query'),
      input: { sql: 'INSERT INTO t VALUES (1)' },
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.refusalText).toContain('[user-denied');
    const req = emit.mock.calls.find((c) => c[0] === 'tool_approval_request');
    expect(req?.[1]).toMatchObject({ toolName: 'db_query', riskClass: 'write' });
  });

  it('INSERT approved → allowed', async () => {
    const { gate } = makeGate({ approved: true });
    const r = await gate.check({
      toolUseId: 'tu3', toolName: 'db_query', tool: byName('db_query'),
      input: { sql: 'INSERT INTO t VALUES (1)' },
    });
    expect(r.allowed).toBe(true);
  });
});
