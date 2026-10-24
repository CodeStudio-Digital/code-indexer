import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../../core/registry.js';
import type { CoderTool, ToolContext } from '../../core/tool.js';
import type { ResolvedSkill } from '../../skills/types.js';
import { buildCapabilityCatalogTool } from '../capability-catalog-tool.js';

function tool(name: string, source: CoderTool['source'] = 'native'): CoderTool {
  return {
    name,
    description: `${name} capability`,
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
    source,
    mutates: false,
    handler: async () => ({ content: 'ok' }),
  };
}

const skill: ResolvedSkill = {
  id: 'unity-audit',
  name: 'Unity Audit',
  description: 'Inspect a Unity project safely',
  slashCommand: null,
  promptBody: 'Inspect ${PROJECT_NAME}: ${USER_INPUT}',
  allowedTools: ['read_file'],
  modelOverride: null,
  providerOverride: null,
  contextMode: 'tool',
  pathPatterns: null,
  triggerPaths: null,
  triggerRoles: null,
  triggerTags: null,
  tags: ['unity', 'audit'],
  source: 'imported',
  author: 'unity-pack',
  sortOrder: 0,
};

function setup() {
  const registry = new ToolRegistry();
  registry.register(tool('read_file'));
  registry.register({
    ...tool('plugin__acme__inspect', 'mcp_external'),
    capabilityProvenance: { kind: 'plugin', providerId: 'acme' },
  });
  const promoteTool = vi.fn(() => []);
  const catalog = buildCapabilityCatalogTool({
    registry,
    skills: [skill],
    skillTemplateContext: {
      PROJECT_NAME: 'Game',
      PROJECT_ROOT: 'D:/game',
      SESSION_ID: 's1',
      OS: 'win32',
      TIMESTAMP: '2026-08-05T00:00:00.000Z',
    },
  });
  const ctx = {
    cwd: 'D:/game',
    projectName: 'Game',
    runner: {
      runId: '11111111-1111-4111-8111-111111111111',
      promoteTool,
    },
  } as unknown as ToolContext;
  return { catalog, ctx, promoteTool, registry };
}

describe('capability_catalog', () => {
  it('rejects malformed or excessive discovery input before scanning the registry', async () => {
    const { catalog, ctx, registry } = setup();
    const list = vi.spyOn(registry, 'list');
    for (const args of [{ op: 'list', cursor: '-1' }, { op: 'list', cursor: '1suffix' },
      { op: 'list', limit: 1.5 }, { op: 'search', query: 'x'.repeat(4001) }]) {
      expect((await catalog.handler(args, ctx)).isError).toBe(true);
    }
    expect(list).not.toHaveBeenCalled();
    ctx.signal = AbortSignal.abort();
    await expect(catalog.handler({ op: 'list' }, ctx)).rejects.toThrow();
    expect(list).not.toHaveBeenCalled();
  });
  it('searches tools, plugins, and skills through one bounded contract', async () => {
    const { catalog, ctx } = setup();
    const pluginResult = await catalog.handler({ op: 'search', query: 'acme inspect' }, ctx);
    const pluginPayload = JSON.parse(pluginResult.content);
    expect(pluginPayload.items[0]).toMatchObject({ source: 'plugin' });

    const skillResult = await catalog.handler({ op: 'search', query: 'unity audit' }, ctx);
    const skillPayload = JSON.parse(skillResult.content);
    expect(skillPayload.items[0]).toMatchObject({ source: 'skill', name: 'unity-audit' });
  });

  it('activates only entries already present in the attempt snapshot', async () => {
    const { catalog, ctx, promoteTool } = setup();
    const described = await catalog.handler({ op: 'search', query: 'read file' }, ctx);
    const readId = JSON.parse(described.content).items[0].capabilityId as string;
    const result = await catalog.handler({
      op: 'activate',
      capability_ids: [readId, 'cap:mcp_external:late_tool'],
    }, ctx);
    const payload = JSON.parse(result.content);

    expect(promoteTool).toHaveBeenCalledWith('read_file');
    expect(payload.activated[0]).toMatchObject({ capabilityId: readId, effective: 'next_turn' });
    expect(payload.rejected[0]).toMatchObject({ reason: 'not_in_attempt_snapshot' });
    expect(payload.capabilitySetDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(payload.projectionState).toBe('recomputed_at_next_turn_boundary');
  });

  it('hydrates an authorized skill without granting missing tool capabilities', async () => {
    const { catalog, ctx } = setup();
    const found = await catalog.handler({ op: 'search', query: 'unity audit' }, ctx);
    const skillId = JSON.parse(found.content).items[0].capabilityId as string;
    const result = await catalog.handler({
      op: 'activate',
      capability_ids: [skillId],
      input: 'scene decals',
    }, ctx);
    const payload = JSON.parse(result.content);

    expect(payload.activated[0].instruction).toContain('Inspect Game: scene decals');
    expect(payload.rejected).toEqual([]);
  });

  it('content-addresses oversized schemas and keeps describe under 64 KiB', async () => {
    const registry = new ToolRegistry();
    registry.register({
      ...tool('large_native'),
      parameters: {
        type: 'object',
        properties: Object.fromEntries(Array.from({ length: 500 }, (_, index) => [
          `field_${index}`,
          { type: 'string', description: 'x'.repeat(128) },
        ])),
      },
    });
    const catalog = buildCapabilityCatalogTool({
      registry,
      skills: [],
      skillTemplateContext: {
        PROJECT_NAME: 'Game',
        PROJECT_ROOT: 'D:/game',
        SESSION_ID: 's1',
        OS: 'win32',
        TIMESTAMP: '2026-08-05T00:00:00.000Z',
      },
    });
    const result = await catalog.handler({
      op: 'describe',
      capability_ids: ['cap:native:large_native'],
    }, { cwd: 'D:/game', projectName: 'Game' } as ToolContext);
    const payload = JSON.parse(result.content);

    expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(64 * 1_024);
    expect(payload.items[0].descriptor.schemaTruncated).toBe(true);
    expect(payload.items[0].descriptor.inputSchema['x-schema-sha256']).toMatch(/^[a-f0-9]{64}$/);
  });
});
