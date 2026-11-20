import { describe, expect, it } from 'vitest';
import type { McpConnectionPolicy } from '@mcp/services/auth/domain/api-token.js';
import { isToolAllowedForPolicy, isToolAllowedForTier } from '../../http/mcp-http-transport.js';
import { allTools } from '../index.js';

const controlledPolicy: McpConnectionPolicy = {
  id: 'controlled',
  name: 'Controlled',
  projectIds: [],
  toolAllowlist: [],
  agentAllowlist: [],
  approvalMode: 'controlled',
  maxConcurrentRuns: 2,
  maxRuntimeMs: 60_000,
};

describe('MCP tool contract', () => {
  it('declares unique names, tiers, scopes and safety annotations for every tool', () => {
    expect(new Set(allTools.map((tool) => tool.name)).size).toBe(allTools.length);
    for (const tool of allTools) {
      expect(['bootstrap', 'navigate', 'admin']).toContain(tool.tier);
      expect(['mcp:read', 'mcp:write', 'mcp:admin']).toContain(tool.scope);
      expect(typeof tool.annotations.readOnlyHint).toBe('boolean');
      expect(typeof tool.annotations.destructiveHint).toBe('boolean');
      expect(typeof tool.annotations.idempotentHint).toBe('boolean');
      expect(typeof tool.annotations.openWorldHint).toBe('boolean');
    }
  });

  it('exposes the documentation tools with the read scope', () => {
    expect(allTools.filter((tool) => tool.name.startsWith('rag_')).map((tool) => [tool.name, tool.scope])).toEqual([
      ['rag_search_docs', 'mcp:read'],
      ['rag_read_doc', 'mcp:read'],
      ['rag_doc_outline', 'mcp:read'],
    ]);
  });

  it('keeps the bootstrap catalog invokable by a read-scoped token', () => {
    const bootstrap = allTools.filter((tool) => isToolAllowedForTier(tool, 'bootstrap'));
    expect(bootstrap.length).toBeGreaterThan(0);
    expect(bootstrap.every((tool) => tool.scope === 'mcp:read')).toBe(true);
  });

  it('applies approval mode and explicit allowlists', () => {
    expect(allTools.filter((tool) => isToolAllowedForPolicy(tool, controlledPolicy))
      .every((tool) => tool.scope !== 'mcp:admin' && !tool.annotations.destructiveHint))
      .toBe(true);

    const allowSearchOnly = { ...controlledPolicy, toolAllowlist: ['search'] };
    expect(allTools.filter((tool) => isToolAllowedForPolicy(tool, allowSearchOnly)).map((tool) => tool.name))
      .toEqual(['search']);
  });
});
