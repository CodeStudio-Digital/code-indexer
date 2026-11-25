import { describe, expect, it } from 'vitest';
import { resolveToolMetadata } from '@mcp/code-agent/core/policy.js';
import type { CoderTool } from '@mcp/code-agent/core/tool.js';
import { withCompanyToolMetadata } from '../metadata.js';

function tool(name: string, overrides: Partial<CoderTool> = {}): CoderTool {
  return {
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    source: 'native',
    handler: async () => ({ content: 'ok' }),
    ...overrides,
  };
}

describe('company tool metadata normalization', () => {
  it('classifies persisted data changes as serialized mutations', () => {
    for (const name of ['env_set', 'write_shared_file', 'kanban_create_card']) {
      expect(resolveToolMetadata(withCompanyToolMetadata(tool(name)))).toMatchObject({
        mutates: true,
        parallelSafe: false,
        riskLevel: 'write',
        repeatPolicy: 'mutating',
        executionClass: 'write',
      });
    }
  });

  it('confines the workspace exemption to native board and orchestration effects', () => {
    for (const name of ['kanban_create_card', 'post_to_board', 'spawn_subordinate_agent', 'ask_master']) {
      expect(withCompanyToolMetadata(tool(name)).effectBoundary, name).toBe('control');
    }
    for (const name of ['service_restart', 'write_shared_file']) {
      expect(withCompanyToolMetadata(tool(name)).effectBoundary, name).not.toBe('control');
    }
    expect(withCompanyToolMetadata(tool('kanban_create_card', { source: 'mcp' })).effectBoundary).toBeUndefined();
  });

  it('keeps live reads parallel-safe but volatile', () => {
    for (const name of [
      'read_board',
      'read_shared_file',
      'docs_read',
      'env_read',
    ]) {
      expect(resolveToolMetadata(withCompanyToolMetadata(tool(name))), name).toMatchObject({
        mutates: false,
        parallelSafe: true,
        riskLevel: 'read',
        repeatPolicy: 'volatile',
        executionClass: 'read',
      });
    }
  });

  it('marks workflows and runtime actions as execute-risk mutations', () => {
    for (const name of ['qa_start_run', 'service_restart', 'review_subordinate_work']) {
      expect(resolveToolMetadata(withCompanyToolMetadata(tool(name))), name).toMatchObject({
        mutates: true,
        parallelSafe: false,
        riskLevel: 'execute',
        repeatPolicy: 'mutating',
        executionClass: 'execute',
      });
    }
  });

  it('serializes orchestration without blocking plan-mode communication', () => {
    expect(resolveToolMetadata(withCompanyToolMetadata(tool('spawn_subordinate_agent')))).toMatchObject({
      mutates: false,
      parallelSafe: false,
      riskLevel: 'read',
      repeatPolicy: 'volatile',
      executionClass: 'control',
    });
  });

  it('treats kanban writes as mutations while keeping kanban reads read-only', () => {
    expect(withCompanyToolMetadata(tool('kanban_create_card'))).toMatchObject({
      mutates: true,
      parallelSafe: false,
      riskLevel: 'write',
      repeatPolicy: 'mutating',
      executionClass: 'write',
    });
    expect(withCompanyToolMetadata(tool('kanban_read_my_card'))).toMatchObject({
      mutates: false,
      parallelSafe: true,
      riskLevel: 'read',
      repeatPolicy: 'volatile',
      executionClass: 'read',
    });
  });

  it('preserves explicit tool metadata', () => {
    const normalized = withCompanyToolMetadata(tool('custom', {
      mutates: false,
      parallelSafe: true,
      riskLevel: 'read',
      repeatPolicy: 'stable',
      executionClass: 'read',
    }));
    expect(normalized).toMatchObject({
      mutates: false,
      parallelSafe: true,
      riskLevel: 'read',
      repeatPolicy: 'stable',
      executionClass: 'read',
    });
  });
});
