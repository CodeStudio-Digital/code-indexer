/**
 * Master tool-filter contract (B5 extension) — the service_* family and
 * the sandbox observability pair must SURVIVE the master filter, while
 * code-level and mutation-surface tools stay stripped.
 */
import { describe, expect, it } from 'vitest';
import type { CoderTool } from '@mcp/code-agent/core/tool.js';
import { isMasterAllowed } from '../master-filter.js';

const native = (name: string): CoderTool =>
  ({
    name,
    description: '',
    source: 'native',
    parameters: { type: 'object', properties: {} },
    handler: async () => ({ content: '' }),
  }) as CoderTool;

const external = (name: string, metadata: Partial<CoderTool> = {}): CoderTool =>
  ({ ...native(name), source: 'mcp_external', ...metadata }) as CoderTool;

describe('isMasterAllowed — service tools (B5)', () => {
  it.each(['service_logs', 'service_restart', 'service_start', 'service_stop'])(
    'keeps %s via the service_ company prefix',
    (name) => {
      expect(isMasterAllowed(native(name))).toBe(true);
    },
  );

  it('keeps the sandbox observability pair for the master', () => {
    expect(isMasterAllowed(native('list_services'))).toBe(true);
    expect(isMasterAllowed(native('read_sandbox_logs'))).toBe(true);
  });

  it('still strips code-level and mutation-surface tools', () => {
    expect(isMasterAllowed(native('db_command'))).toBe(false);
    expect(isMasterAllowed(native('read_file'))).toBe(false);
    expect(isMasterAllowed(native('write_file'))).toBe(false);
    expect(isMasterAllowed(native('env_set'))).toBe(false);
  });
});

describe('isMasterAllowed — C4 batch/graph tools survive the filter', () => {
  it('keeps approve_subordinate_plans via the approve_subordinate prefix', () => {
    expect(isMasterAllowed(native('approve_subordinate_plans'))).toBe(true);
  });

  it('keeps kanban_plan_graph via the kanban_ prefix', () => {
    expect(isMasterAllowed(native('kanban_plan_graph'))).toBe(true);
  });
});

describe('isMasterAllowed — external MCP is default-deny', () => {
  it('rejects unclassified and mutating external tools', () => {
    expect(isMasterAllowed(external('ext_repo__read_file'))).toBe(false);
    expect(isMasterAllowed(external('ext_cloud__publish', {
      mutates: true,
      riskLevel: 'admin',
    }))).toBe(false);
  });

  it('keeps an explicitly declared read-only connector tool', () => {
    expect(isMasterAllowed(external('ext_observability__get_status', {
      mutates: false,
      riskLevel: 'read',
      parallelSafe: true,
    }))).toBe(true);
  });
});
