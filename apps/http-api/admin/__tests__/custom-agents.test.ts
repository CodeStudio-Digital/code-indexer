import { describe, expect, it } from 'vitest';
import {
  createCustomAgent,
  CustomAgentValidationError,
  deleteCustomAgent,
  listCustomAgents,
  resolveAgentSelection,
  upsertManagedAgent,
  updateCustomAgent,
} from '../../custom-agents.js';
import { customAgentsRouter } from '../custom-agents.routes.js';

function memoryStore() {
  const values = new Map<string, string>();
  return {
    values,
    getAppSetting(key: string) { return values.get(key) ?? null; },
    setAppSetting(key: string, value: string) { values.set(key, value); },
  };
}

describe('custom agent definitions', () => {
  it('describes the concrete tool catalog inherited from each base preset', async () => {
    const response = await customAgentsRouter(memoryStore() as never).request('/custom-agents');
    const payload = await response.json() as {
      presets: Array<{ id: string; defaultToolNames: string[]; defaultToolTiers: string[] }>;
    };

    const build = payload.presets.find((preset) => preset.id === 'build');
    expect(build?.defaultToolTiers).toEqual(['bootstrap', 'navigate']);
    expect(build?.defaultToolNames.length).toBeGreaterThan(0);
    expect(new Set(build?.defaultToolNames).size).toBe(build?.defaultToolNames.length);

    expect(payload.presets.find((preset) => preset.id === 'app_db')?.defaultToolTiers).toContain('db');
    expect(payload.presets.find((preset) => preset.id === 'api')?.defaultToolTiers).toContain('api');
    expect(payload.presets.find((preset) => preset.id === 'diagram')?.defaultToolTiers).toContain('diagram');
  });

  it('persists a stable selection id and resolves the inherited preset', () => {
    const store = memoryStore();
    const created = createCustomAgent(store, {
      name: 'Security reviewer',
      description: 'Reviews risky changes',
      baseAgentId: 'plan',
      prompt: 'Focus on trust boundaries.',
      skillIds: ['security', 'security', ' repo-review '],
      toolNames: ['read_file', 'grep'],
      enabled: true,
    });

    expect(created.selectionId).toBe(`custom:${created.id}`);
    expect(created.skillIds).toEqual(['security', 'repo-review']);
    expect(listCustomAgents(store)).toHaveLength(1);
    expect(store.values.values().next().value).not.toContain('selectionId');

    const resolved = resolveAgentSelection(store, created.selectionId);
    expect(resolved?.baseAgentId).toBe('plan');
    expect(resolved?.base.planMode).toBe(true);
    expect(resolved?.custom?.toolNames).toEqual(['read_file', 'grep']);
  });

  it('distinguishes inherited tools from an intentionally empty allowlist', () => {
    const store = memoryStore();
    const created = createCustomAgent(store, {
      name: 'Writer',
      baseAgentId: 'build',
      skillIds: [],
      toolNames: null,
    });
    expect(created.toolNames).toBeNull();

    const updated = updateCustomAgent(store, created.id, { toolNames: [] });
    expect(updated?.toolNames).toEqual([]);
  });

  it('hides disabled agents from runtime resolution but keeps them editable', () => {
    const store = memoryStore();
    const created = createCustomAgent(store, {
      name: 'Paused agent',
      baseAgentId: 'explore',
      skillIds: [],
      toolNames: null,
      enabled: false,
    });

    expect(resolveAgentSelection(store, created.selectionId)).toBeNull();
    expect(resolveAgentSelection(store, created.selectionId, { includeDisabled: true })?.custom?.enabled).toBe(false);
    expect(deleteCustomAgent(store, created.id)).toBe(true);
    expect(deleteCustomAgent(store, created.id)).toBe(false);
  });

  it('rejects unknown base presets and oversized names', () => {
    const store = memoryStore();
    expect(() => createCustomAgent(store, { name: 'Bad', baseAgentId: 'unknown' }))
      .toThrow(CustomAgentValidationError);
    expect(() => createCustomAgent(store, { name: 'x'.repeat(81), baseAgentId: 'build' }))
      .toThrow('name supports at most 80 characters');
  });

  it('idempotently installs an extension-managed build agent with pins and required tiers', async () => {
    const store = memoryStore();
    const input = {
      managedBy: 'com.example.unity',
      managedVersion: '1.2.3',
      name: 'Unity Build',
      description: 'Builds through the live editor',
      baseAgentId: 'build',
      prompt: 'Use Unity MCP.',
      skillIds: ['unity-project-scout'],
      pinnedToolNames: ['ext_unity__get_server_health', 'ext_unity__create_scene'],
      requiredToolTiers: ['unity'],
      visibleToolCap: 64,
      toolNames: null,
      enabled: true,
    };

    const created = upsertManagedAgent(store, 'unity-build', input);
    expect(created.selectionId).toBe('custom:unity-build');
    expect(created.managedBy).toBe('com.example.unity');
    expect(created.requiredToolTiers).toEqual(['unity']);
    expect(created.pinnedToolNames).toContain('ext_unity__get_server_health');
    expect(created.visibleToolCap).toBe(64);

    const updated = upsertManagedAgent(store, 'unity-build', {
      ...input,
      managedVersion: '1.2.4',
      prompt: 'Use the live Unity MCP route.',
    });
    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.managedVersion).toBe('1.2.4');
    expect(listCustomAgents(store)).toHaveLength(1);
    expect(() => updateCustomAgent(store, 'unity-build', { name: 'Hijacked' }))
      .toThrow('must be updated by that extension');

    const response = await customAgentsRouter(store as never).request(
      '/custom-agents/managed/unity-build',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...input, managedVersion: '1.2.5' }),
      },
    );
    expect(response.status).toBe(200);
    expect((await response.json() as { selectionId: string; managedVersion: string })).toMatchObject({
      selectionId: 'custom:unity-build',
      managedVersion: '1.2.5',
    });
  });
});
