import { describe, it, expect } from 'vitest';
import { buildSkillDiscoveryTools } from '@mcp/code-agent/skills/skill-tool-builder.js';
import type { ResolvedSkill, SkillSource, SkillTemplateContext } from '@mcp/code-agent/skills/types.js';
import type { InstalledNamespaceSummary } from '@mcp/code-agent/skills/agent-skills-installer.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';

const toolCtx: ToolContext = {
  cwd: '/test',
  projectName: 'test',
};

/**
 * Discovery tools — list_skill_namespaces / get_skills_list / get_skill_content.
 * These form the 3-level hierarchy the agent walks to find a skill without
 * dumping every skill body into the system prompt.
 */

function fakeSkill(
  id: string,
  options: { source?: SkillSource; author?: string | null; description?: string } = {},
): ResolvedSkill {
  return {
    id,
    name: id,
    description: options.description ?? `Description for ${id}`,
    slashCommand: null,
    promptBody: `body of ${id}`,
    allowedTools: null,
    modelOverride: null,
    providerOverride: null,
    contextMode: 'auto',
    pathPatterns: null,
    triggerPaths: null,
    triggerRoles: null,
    triggerTags: null,
    tags: [],
    source: options.source ?? 'builtin',
    author: options.author ?? null,
    sortOrder: 0,
  };
}

const ctx: SkillTemplateContext = {
  PROJECT_NAME: 'test',
  PROJECT_ROOT: '/test',
  SESSION_ID: '1',
  OS: 'linux',
  TIMESTAMP: 'now',
};

describe('discovery tools — list_skill_namespaces', () => {
  it('returns one entry per namespace with counts and sample IDs, ordered user → installed A-Z → builtin', async () => {
    const skills: ResolvedSkill[] = [
      fakeSkill('user-deploy', { source: 'user' }),
      fakeSkill('user-test', { source: 'user' }),
      fakeSkill('docx', { source: 'imported', author: 'anthropic-skills' }),
      fakeSkill('pdf', { source: 'imported', author: 'anthropic-skills' }),
      fakeSkill('xlsx', { source: 'imported', author: 'anthropic-skills' }),
      fakeSkill('init', { source: 'builtin' }),
    ];
    const installed: InstalledNamespaceSummary[] = [
      {
        namespace: 'anthropic-skills',
        repo: 'anthropics/skills',
        commit: 'abc1234',
        skillCount: 3,
        commandCount: 0,
        mcpCount: 0,
      },
    ];
    const tools = buildSkillDiscoveryTools(skills, ctx, undefined, undefined, installed);
    const namespacesTool = tools.find((t) => t.name === 'list_skill_namespaces')!;
    const result = await namespacesTool.handler({}, toolCtx);
    const parsed = JSON.parse(result.content as string);
    expect(parsed.totalSkills).toBe(6);
    expect(parsed.namespaces).toHaveLength(3);
    // Order: user → anthropic-skills (installed) → builtin
    expect(parsed.namespaces[0].namespace).toBe('user');
    expect(parsed.namespaces[0].count).toBe(2);
    expect(parsed.namespaces[1].namespace).toBe('anthropic-skills');
    expect(parsed.namespaces[1].count).toBe(3);
    expect(parsed.namespaces[1].repo).toBe('anthropics/skills');
    expect(parsed.namespaces[1].commit).toBe('abc1234');
    expect(parsed.namespaces[1].sampleSkillIds).toEqual(['docx', 'pdf', 'xlsx']);
    expect(parsed.namespaces[2].namespace).toBe('builtin');
  });

  it('caps sampleSkillIds at 5 per namespace', async () => {
    const skills = Array.from({ length: 12 }, (_, i) =>
      fakeSkill(`skill-${String(i).padStart(2, '0')}`, {
        source: 'imported',
        author: 'big-pack',
      }),
    );
    const tools = buildSkillDiscoveryTools(skills, ctx);
    const result = await tools
      .find((t) => t.name === 'list_skill_namespaces')!
      .handler({}, toolCtx);
    const parsed = JSON.parse(result.content as string);
    expect(parsed.namespaces[0].sampleSkillIds).toHaveLength(5);
    // Alphabetical: 00,01,02,03,04
    expect(parsed.namespaces[0].sampleSkillIds[0]).toBe('skill-00');
    expect(parsed.namespaces[0].sampleSkillIds[4]).toBe('skill-04');
  });

  it('degrades gracefully when installedNamespaces is omitted (repo/commit null)', async () => {
    const skills: ResolvedSkill[] = [
      fakeSkill('foo', { source: 'imported', author: 'unknown-pack' }),
    ];
    const tools = buildSkillDiscoveryTools(skills, ctx);
    const result = await tools
      .find((t) => t.name === 'list_skill_namespaces')!
      .handler({}, toolCtx);
    const parsed = JSON.parse(result.content as string);
    expect(parsed.namespaces[0].namespace).toBe('unknown-pack');
    expect(parsed.namespaces[0].repo).toBeNull();
    expect(parsed.namespaces[0].commit).toBeNull();
  });
});

describe('discovery tools — get_skills_list', () => {
  it('without namespace returns the compact overview with byNamespace counts and a hint', async () => {
    const skills: ResolvedSkill[] = [
      fakeSkill('a', { source: 'user' }),
      fakeSkill('b', { source: 'imported', author: 'pack-x' }),
      fakeSkill('c', { source: 'imported', author: 'pack-x' }),
    ];
    const tools = buildSkillDiscoveryTools(skills, ctx);
    const result = await tools.find((t) => t.name === 'get_skills_list')!.handler({}, toolCtx);
    const parsed = JSON.parse(result.content as string);
    expect(parsed.totalSkills).toBe(3);
    expect(parsed.byNamespace).toEqual([
      { namespace: 'user', count: 1 },
      { namespace: 'pack-x', count: 2 },
    ]);
    expect(parsed.hint).toContain('list_skill_namespaces');
  });

  it('with namespace returns only the matching skills, sorted by id', async () => {
    const skills: ResolvedSkill[] = [
      fakeSkill('zeta', { source: 'imported', author: 'pack-x' }),
      fakeSkill('alpha', { source: 'imported', author: 'pack-x' }),
      fakeSkill('user-1', { source: 'user' }),
    ];
    const tools = buildSkillDiscoveryTools(skills, ctx);
    const result = await tools
      .find((t) => t.name === 'get_skills_list')!
      .handler({ namespace: 'pack-x' }, toolCtx);
    const parsed = JSON.parse(result.content as string);
    expect(parsed.namespace).toBe('pack-x');
    expect(parsed.count).toBe(2);
    expect(parsed.skills.map((s: { id: string }) => s.id)).toEqual(['alpha', 'zeta']);
  });

  it('with unknown namespace returns instructive error listing valid options', async () => {
    const skills: ResolvedSkill[] = [
      fakeSkill('a', { source: 'user' }),
      fakeSkill('b', { source: 'builtin' }),
    ];
    const tools = buildSkillDiscoveryTools(skills, ctx);
    const result = await tools
      .find((t) => t.name === 'get_skills_list')!
      .handler({ namespace: 'does-not-exist' }, toolCtx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('does-not-exist');
    expect(result.content).toContain('user');
    expect(result.content).toContain('builtin');
    expect(result.content).toContain('list_skill_namespaces');
  });
});

describe('discovery tools — registration', () => {
  it('returns three tools: list_skill_namespaces, get_skills_list, get_skill_content', () => {
    const skills: ResolvedSkill[] = [fakeSkill('x', { source: 'user' })];
    const tools = buildSkillDiscoveryTools(skills, ctx);
    expect(tools.map((t) => t.name)).toEqual([
      'list_skill_namespaces',
      'get_skills_list',
      'get_skill_content',
    ]);
  });
});
