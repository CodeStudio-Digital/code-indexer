/**
 * PermissionGate — mode × risk-class matrix, MCP name heuristics, the pause
 * protocol (slot-before-event, approve/deny/interrupt/abort payloads) and
 * the per-session "always allow" grant set.
 */
import { describe, it, expect } from 'vitest';
import type { CoderTool } from '@mcp/code-agent/core/tool.js';
import {
  PermissionGate,
  approvalAskId,
  buildUserDeniedText,
  classifyForGate,
  normalizeToolPermissionMode,
  type PermissionGateDeps,
  type ToolPermissionMode,
} from '../permission-gate.js';

function tool(partial: Partial<CoderTool> & { name: string }): CoderTool {
  return {
    description: `${partial.name} tool`,
    parameters: { type: 'object', properties: {} },
    source: 'native',
    handler: async () => ({ content: 'ok' }),
    ...partial,
  } as CoderTool;
}

function harness(mode: ToolPermissionMode) {
  const slots = new Map<string, (v: string) => void>();
  const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const grants: string[] = [];
  const deps: PermissionGateDeps = {
    getMode: () => mode,
    emit: (event, payload) => { events.push({ event, payload }); },
    waitForUserInput: (askId) => new Promise((resolve) => { slots.set(askId, resolve); }),
    onGrant: (t) => { grants.push(t); },
  };
  const gate = new PermissionGate(deps);
  const answer = (toolUseId: string, verdict: unknown): void => {
    const r = slots.get(approvalAskId(toolUseId));
    if (!r) throw new Error(`no slot for ${toolUseId}`);
    slots.delete(approvalAskId(toolUseId));
    r(typeof verdict === 'string' ? verdict : JSON.stringify(verdict));
  };
  return { gate, slots, events, grants, answer };
}

describe('classifyForGate', () => {
  it('maps declared riskLevels and builtin classifications', () => {
    expect(classifyForGate(tool({ name: 'write_file', mutates: true, riskLevel: 'write' }), 'write_file')).toBe('write');
    expect(classifyForGate(tool({ name: 'run_command' }), 'run_command')).toBe('execute'); // builtin
    expect(classifyForGate(tool({ name: 'git_commit' }), 'git_commit')).toBe('admin'); // builtin
    expect(classifyForGate(tool({ name: 'read_file' }), 'read_file')).toBe('allow'); // builtin read
  });

  it('never gates interactive tools and wrapper tools', () => {
    expect(classifyForGate(tool({ name: 'ask_user' }), 'ask_user')).toBe('allow'); // builtin interactive
    expect(classifyForGate(tool({ name: 'code_exec', riskLevel: 'execute' }), 'code_exec')).toBe('allow');
    expect(classifyForGate(tool({ name: 'spawn_agent' }), 'spawn_agent')).toBe('allow');
    expect(classifyForGate(tool({ name: 'execute_tasks' }), 'execute_tasks')).toBe('allow');
  });

  it('classifies undeclared MCP tools by name heuristics', () => {
    const mcp = (name: string) => tool({ name, source: 'mcp_external' });
    expect(classifyForGate(mcp('mcp__cf__r2_bucket_delete'), 'mcp__cf__r2_bucket_delete')).toBe('admin');
    expect(classifyForGate(mcp('mcp__cf__workers_deploy'), 'mcp__cf__workers_deploy')).toBe('admin');
    expect(classifyForGate(mcp('mcp__cf__kv_namespaces_list'), 'mcp__cf__kv_namespaces_list')).toBe('allow');
    expect(classifyForGate(mcp('mcp__x__get_thing'), 'mcp__x__get_thing')).toBe('allow');
    // No verb match either way → conservative write.
    expect(classifyForGate(mcp('mcp__cf__hyperdrive_config_edit'), 'mcp__cf__hyperdrive_config_edit')).toBe('write');
    expect(classifyForGate(mcp('mcp__x__do_something'), 'mcp__x__do_something')).toBe('write');
  });

  it('trusts explicit metadata on MCP tools', () => {
    const declared = tool({ name: 'mcp__x__scan', source: 'mcp_external', mutates: false });
    expect(classifyForGate(declared, 'mcp__x__scan')).toBe('allow');
  });

  it('treats native unclassified tools as allow (legacy posture) and unknown names as write', () => {
    expect(classifyForGate(tool({ name: 'some_native_helper' }), 'some_native_helper')).toBe('allow');
    expect(classifyForGate(undefined, 'ghost_tool')).toBe('write');
  });
});

describe('PermissionGate.check — mode matrix', () => {
  const writeTool = tool({ name: 'write_file', mutates: true, riskLevel: 'write' });
  const execTool = tool({ name: 'run_command', riskLevel: 'execute' });

  it('unrestricted never pauses', async () => {
    const h = harness('unrestricted');
    const r = await h.gate.check({ toolUseId: 'a', toolName: 'run_command', input: {}, tool: execTool });
    expect(r.allowed).toBe(true);
    expect(h.slots.size).toBe(0);
    expect(h.events).toHaveLength(0);
  });

  it('auto lets write through but pauses execute', async () => {
    const h = harness('auto');
    const w = await h.gate.check({ toolUseId: 'w', toolName: 'write_file', input: {}, tool: writeTool });
    expect(w.allowed).toBe(true);
    const pending = h.gate.check({ toolUseId: 'x', toolName: 'run_command', input: { command: 'ls' }, tool: execTool });
    expect(h.gate.pendingCount()).toBe(1);
    h.answer('x', { approved: true });
    expect((await pending).allowed).toBe(true);
    expect(h.gate.pendingCount()).toBe(0);
  });

  it('ask pauses write too', async () => {
    const h = harness('ask');
    const pending = h.gate.check({ toolUseId: 'w', toolName: 'write_file', input: {}, tool: writeTool });
    h.answer('w', { approved: true });
    expect((await pending).allowed).toBe(true);
  });
});

describe('PermissionGate.check — pause protocol', () => {
  const execTool = tool({ name: 'run_command', riskLevel: 'execute' });

  it('registers the wait slot BEFORE emitting the request event', async () => {
    const observed: string[] = [];
    const slots = new Map<string, (v: string) => void>();
    const gate = new PermissionGate({
      getMode: () => 'ask',
      emit: (event) => { observed.push(`emit:${event}`); },
      waitForUserInput: (askId) => {
        observed.push('slot');
        return new Promise((resolve) => { slots.set(askId, resolve); });
      },
    });
    const pending = gate.check({ toolUseId: 't1', toolName: 'run_command', input: {}, tool: execTool });
    expect(observed[0]).toBe('slot');
    expect(observed[1]).toBe('emit:tool_approval_request');
    slots.get(approvalAskId('t1'))!(JSON.stringify({ approved: true }));
    await pending;
    expect(observed[2]).toBe('emit:tool_approval_resolved');
  });

  it('deny with note → [user-denied refusal carrying the note', async () => {
    const h = harness('ask');
    const pending = h.gate.check({ toolUseId: 'd1', toolName: 'run_command', input: {}, tool: execTool });
    h.answer('d1', { approved: false, note: 'use pnpm instead' });
    const r = await pending;
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.refusalText.startsWith('[user-denied')).toBe(true);
      expect(r.refusalText).toContain('use pnpm instead');
    }
    const resolved = h.events.find((e) => e.event === 'tool_approval_resolved');
    expect(resolved?.payload).toMatchObject({ approved: false, source: 'user', note: 'use pnpm instead' });
  });

  it('interrupt payload denies with source=interrupt', async () => {
    const h = harness('ask');
    const pending = h.gate.check({ toolUseId: 'i1', toolName: 'run_command', input: {}, tool: execTool });
    h.answer('i1', { interrupted: true });
    const r = await pending;
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.refusalText.startsWith('[user-denied')).toBe(true);
    expect(h.events.at(-1)?.payload).toMatchObject({ approved: false, source: 'interrupt' });
  });

  it('abort payload denies WITHOUT the user-denied prefix', async () => {
    const h = harness('ask');
    const pending = h.gate.check({ toolUseId: 'a1', toolName: 'run_command', input: {}, tool: execTool });
    h.answer('a1', { aborted: true });
    const r = await pending;
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.refusalText.startsWith('[tool-aborted')).toBe(true);
      expect(r.refusalText.includes('[user-denied')).toBe(false);
    }
    expect(h.events.at(-1)?.payload).toMatchObject({ approved: false, source: 'abort' });
  });

  it('unparseable payload fails safe to deny', async () => {
    const h = harness('ask');
    const pending = h.gate.check({ toolUseId: 'g1', toolName: 'run_command', input: {}, tool: execTool });
    h.answer('g1', 'not-json-at-all');
    const r = await pending;
    expect(r.allowed).toBe(false);
  });

  it('always-allow grants skip future pauses and persist via onGrant once', async () => {
    const h = harness('ask');
    const first = h.gate.check({ toolUseId: 'p1', toolName: 'run_command', input: {}, tool: execTool });
    h.answer('p1', { approved: true, alwaysAllow: true });
    expect((await first).allowed).toBe(true);
    expect(h.grants).toEqual(['run_command']);
    // Second call: no pause at all.
    const second = await h.gate.check({ toolUseId: 'p2', toolName: 'run_command', input: {}, tool: execTool });
    expect(second.allowed).toBe(true);
    expect(h.slots.has(approvalAskId('p2'))).toBe(false);
    expect(h.grants).toHaveLength(1);
  });

  it('seeds grants from initialGrants', async () => {
    const gate = new PermissionGate({
      getMode: () => 'ask',
      emit: () => { /* never */ },
      waitForUserInput: () => { throw new Error('must not pause'); },
      initialGrants: ['run_command'],
    });
    const r = await gate.check({ toolUseId: 's1', toolName: 'run_command', input: {}, tool: execTool });
    expect(r.allowed).toBe(true);
  });
});

describe('helpers', () => {
  it('normalizeToolPermissionMode coerces junk to the fallback', () => {
    expect(normalizeToolPermissionMode('ask')).toBe('ask');
    expect(normalizeToolPermissionMode('unrestricted')).toBe('unrestricted');
    expect(normalizeToolPermissionMode(null)).toBe('auto');
    expect(normalizeToolPermissionMode('yolo')).toBe('auto');
    expect(normalizeToolPermissionMode(undefined, 'unrestricted')).toBe('unrestricted');
  });

  it('buildUserDeniedText keeps the stable prefix and optional note', () => {
    expect(buildUserDeniedText('write_file').startsWith('[user-denied:')).toBe(true);
    expect(buildUserDeniedText('write_file', ' nope ')).toContain('Motivo: nope.');
  });
});
