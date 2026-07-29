/**
 * Task-preflight unit tests — no SQLite, no real LLM. The resolver is a
 * stub object and the provider call is intercepted via `fetchFn`, so the
 * suite runs ABI-free.
 */
import { describe, expect, it } from 'vitest';
import { asSessionId } from '@mcp/session-storage';
import type { PipelineProviderResolver, ResolvedBinding } from '../../../pipelines/index.js';
import {
  TaskPreflightService,
  type TaskPreflightDeps,
  type TaskPreflightInput,
} from '../preflight-pipeline.js';
import {
  buildPreflightMessages,
  cleanSessionTitle,
  cleanSessionTitleSeed,
  isAutomaticSessionTitle,
  parsePreflightOutput,
} from '../preflight-prompt.js';

const CATALOG = [
  { name: 'read_file', tier: 'bootstrap', description: 'Read file contents' },
  { name: 'edit_file', tier: 'navigate', description: 'Find/replace edit' },
  { name: 'mcp__search', tier: 'bootstrap', description: 'Hybrid search' },
  { name: 'git_commit', tier: 'admin' },
  { name: 'ext_srv__do_thing', tier: 'srv', description: 'External integration call' },
];
const MEMORY = [
  { title: 'Auth token refresh gotcha', category: 'gotcha', excerpt: 'refresh expires in 25min' },
  { title: 'API error envelope', category: 'convention' },
];
const SKILLS = [
  { id: 'api-collection', description: 'Build or import an HTTP API client collection', namespace: 'builtin', scope: '7' },
  { id: 'qa-playwright', description: 'Author Playwright E2E tests', namespace: 'builtin', scope: '7' },
  { id: 'ds-docs', description: 'Generate design-system docs', namespace: 'builtin', scope: '7' },
  { id: 'init', description: 'Initialize a CLAUDE.md for the repo', namespace: 'builtin', scope: '7' },
];
const PARSE_CTX = {
  toolNames: new Set(CATALOG.map((t) => t.name)),
  memoryTitles: MEMORY.map((m) => m.title),
  skillIds: new Set(SKILLS.map((s) => s.id)),
  maxTools: 3,
  maxMemories: 2,
  maxSkills: 2,
};

function makeBinding(provider: Record<string, unknown> = {}): ResolvedBinding {
  return {
    pipelineName: 'code-agent',
    bindingRole: 'preflight',
    provider: {
      id: 'cf-1',
      name: 'Cloudflare',
      kind: 'cloudflare',
      api_key: 'tok',
      base_url: null,
      enabled: 1,
      extra: { account_id: 'acc' },
      ...provider,
    },
    modelId: '@cf/meta/llama-3.1-8b-instruct',
    modelMode: '',
    config: { temperature: 0, max_tokens: 700 },
    resolvedFrom: 'global',
    bindingId: 1,
  } as unknown as ResolvedBinding;
}

function makeResolver(binding: ResolvedBinding | null): PipelineProviderResolver {
  return { resolveOrNull: async () => binding } as unknown as PipelineProviderResolver;
}

function makeService(binding: ResolvedBinding | null, extra: Partial<TaskPreflightDeps> = {}): TaskPreflightService {
  return new TaskPreflightService({
    resolver: makeResolver(binding),
    getToolCatalog: () => CATALOG,
    getMemoryIndex: () => MEMORY,
    getSkillCatalog: () => SKILLS,
    ...extra,
  });
}

function okFetch(content: string): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

const VALID_OUTPUT = JSON.stringify({
  session_title: 'Corrigir autenticação de login',
  task_kind: 'bugfix',
  profile: 'navigate',
  tools: [{ name: 'read_file', why: 'inspect' }, { name: 'edit_file', why: 'fix' }],
  memories: [{ title: 'auth token refresh GOTCHA', why: 'same login flow' }],
});

describe('parsePreflightOutput', () => {
  it('parses clean JSON and canonicalizes memory titles case-insensitively', () => {
    const seed = parsePreflightOutput(VALID_OUTPUT, PARSE_CTX);
    expect(seed).toEqual({
      sessionTitle: 'Corrigir autenticação de login',
      profile: 'navigate',
      taskKind: 'bugfix',
      pinTools: ['read_file', 'edit_file'],
      memories: [{ title: 'Auth token refresh gotcha', reason: 'same login flow' }],
    });
  });

  it('parses fenced and prose-wrapped JSON', () => {
    expect(parsePreflightOutput('```json\n' + VALID_OUTPUT + '\n```', PARSE_CTX)).not.toBeNull();
    expect(parsePreflightOutput(`Sure! Here you go: ${VALID_OUTPUT} hope it helps`, PARSE_CTX)).not.toBeNull();
  });

  it('drops hallucinated tool names and clamps to maxTools', () => {
    const raw = JSON.stringify({
      profile: 'bootstrap',
      tools: [
        { name: 'made_up_tool' },
        { name: 'read_file' },
        { name: 'read_file' }, // duplicate
        { name: 'edit_file' },
        { name: 'mcp__search' },
        { name: 'git_commit' }, // over the cap of 3
      ],
    });
    const seed = parsePreflightOutput(raw, PARSE_CTX);
    expect(seed?.pinTools).toEqual(['read_file', 'edit_file', 'mcp__search']);
  });

  it('pins an external MCP tool when the catalog lists it', () => {
    const raw = JSON.stringify({ tools: [{ name: 'ext_srv__do_thing', why: 'call the API' }] });
    const seed = parsePreflightOutput(raw, PARSE_CTX);
    expect(seed?.pinTools).toEqual(['ext_srv__do_thing']);
  });

  it('parses skill suggestions, accepts string entries, drops unknown ids', () => {
    const raw = JSON.stringify({
      skills: [
        { id: 'api-collection', why: 'task builds an API client' },
        { id: 'made-up-skill', why: 'x' },
        'qa-playwright',
      ],
    });
    const seed = parsePreflightOutput(raw, PARSE_CTX);
    expect(seed?.suggestedSkills).toEqual([
      { id: 'api-collection', reason: 'task builds an API client' },
      { id: 'qa-playwright', reason: '' },
    ]);
  });

  it('clamps skills to maxSkills and dedups', () => {
    const raw = JSON.stringify({
      skills: ['api-collection', 'api-collection', 'qa-playwright', 'ds-docs'],
    });
    const seed = parsePreflightOutput(raw, PARSE_CTX);
    expect(seed?.suggestedSkills?.map((s) => s.id)).toEqual(['api-collection', 'qa-playwright']);
  });

  it('clamps skills to the shipped cap (3) when more valid ids are returned', () => {
    // Pins the production MAX_SKILLS=3 (preflight-pipeline.ts) end of the clamp.
    const ctx3 = { ...PARSE_CTX, maxSkills: 3 };
    const raw = JSON.stringify({ skills: ['api-collection', 'qa-playwright', 'ds-docs', 'init'] });
    const seed = parsePreflightOutput(raw, ctx3);
    expect(seed?.suggestedSkills?.map((s) => s.id)).toEqual(['api-collection', 'qa-playwright', 'ds-docs']);
  });

  it('a skills-only seed is usable (not null)', () => {
    const seed = parsePreflightOutput(JSON.stringify({ skills: ['api-collection'] }), PARSE_CTX);
    expect(seed).not.toBeNull();
    expect(seed?.suggestedSkills?.[0]?.id).toBe('api-collection');
    expect(seed?.pinTools).toBeUndefined();
  });

  it('rejects a valid skill id when deterministic evidence is absent', () => {
    const seed = parsePreflightOutput(JSON.stringify({ skills: ['api-collection'] }), {
      ...PARSE_CTX,
      skillMetaById: new Map([['api-collection', { evidence: undefined }]]),
    });
    expect(seed).toBeNull();
  });

  it('accepts plain-string tool entries and drops unknown memory titles', () => {
    const raw = JSON.stringify({
      tools: ['read_file'],
      memories: [{ title: 'Invented memory', why: 'x' }],
    });
    const seed = parsePreflightOutput(raw, PARSE_CTX);
    expect(seed?.pinTools).toEqual(['read_file']);
    expect(seed?.memories).toBeUndefined();
  });

  it('invalid profile/task_kind fail independently without killing the seed', () => {
    const raw = JSON.stringify({ profile: 'god-mode', task_kind: 'wat', tools: ['edit_file'] });
    const seed = parsePreflightOutput(raw, PARSE_CTX);
    expect(seed?.profile).toBeUndefined();
    expect(seed?.taskKind).toBeUndefined();
    expect(seed?.pinTools).toEqual(['edit_file']);
  });

  it('accepts and canonicalizes a task_kind-only seed', () => {
    expect(parsePreflightOutput(
      JSON.stringify({ task_kind: '  BugFix  ' }),
      PARSE_CTX,
    )).toEqual({ taskKind: 'bugfix' });
  });

  it('returns null for garbage, arrays, and empty-after-validation outputs', () => {
    expect(parsePreflightOutput('not json at all', PARSE_CTX)).toBeNull();
    expect(parsePreflightOutput('[1,2,3]', PARSE_CTX)).toBeNull();
    expect(parsePreflightOutput(JSON.stringify({ tools: [{ name: 'nope' }] }), PARSE_CTX)).toBeNull();
    expect(parsePreflightOutput(JSON.stringify({ skills: ['nope'] }), PARSE_CTX)).toBeNull();
  });

  it('accepts a title-only result and sanitizes common model wrappers', () => {
    expect(parsePreflightOutput(JSON.stringify({ session_title: '"Corrigir login quebrado."' }), PARSE_CTX)).toEqual({
      sessionTitle: 'Corrigir login quebrado',
    });
    expect(cleanSessionTitle('{"title":"Revisar pipeline de build!"}')).toBe('Revisar pipeline de build');
  });

  it('recognizes automatic placeholders and strips context from title seeds', () => {
    expect(isAutomaticSessionTitle('Nova sessão')).toBe(true);
    expect(isAutomaticSessionTitle('New session')).toBe(true);
    expect(isAutomaticSessionTitle('Minha tarefa')).toBe(false);
    expect(cleanSessionTitleSeed('<file_refs>x</file_refs> Corrija o login')).toBe('Corrija o login');
  });
});

describe('buildPreflightMessages', () => {
  it('includes task + catalog, omits skill/memory blocks when empty, truncates long tasks', () => {
    const long = 'x'.repeat(2500);
    const messages = buildPreflightMessages({
      userMessage: long,
      toolCatalog: CATALOG,
      memoryIndex: [],
      skillCatalog: [],
      maxTools: 12,
      maxMemories: 5,
      maxSkills: 3,
    });
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).toContain('AT MOST 12 tools');
    expect(messages[0]!.content).toContain('AT MOST 3 skills');
    expect(messages[0]!.content).toContain('session_title');
    const user = messages[1]!.content;
    expect(user).toContain('<task>');
    expect(user).toContain('...[truncated]');
    expect(user).toContain('read_file [bootstrap] Read file contents');
    expect(user).not.toContain('<memory_index>');
    expect(user).not.toContain('<skill_catalog>');
  });

  it('renders the memory index and skill catalog when present', () => {
    const user = buildPreflightMessages({
      userMessage: 'fix login',
      toolCatalog: CATALOG,
      memoryIndex: MEMORY,
      skillCatalog: SKILLS,
      maxTools: 12,
      maxMemories: 5,
      maxSkills: 3,
    })[1]!.content;
    expect(user).toContain('<memory_index>');
    expect(user).toContain('- [gotcha] Auth token refresh gotcha — "refresh expires in 25min"');
    expect(user).toContain('<skill_catalog>');
    expect(user).toContain('- api-collection [builtin] — Build or import an HTTP API client collection');
  });
});

describe('TaskPreflightService.run', () => {
  const INPUT: TaskPreflightInput = {
    sessionId: asSessionId('00000000-0000-4000-8000-000000000001'),
    projectId: 7,
    userMessage: 'corrija o bug de login',
  };

  it('returns unconfigured when no binding resolves and no fallback is set', async () => {
    const result = await makeService(null).run(INPUT);
    expect(result.status).toBe('unconfigured');
    expect(result.seed).toBeUndefined();
  });

  it('runs zero-config: resolves via the general-default fallback when no binding row exists', async () => {
    const binding = makeBinding();
    // Resolver mirrors PipelineProviderResolver: returns a binding ONLY when a
    // fallbackDefault is supplied (no DB row otherwise).
    const resolver = {
      resolveOrNull: async (_p: string, _r: string, _ctx: unknown, fallback?: unknown) =>
        (fallback ? binding : null),
    } as unknown as PipelineProviderResolver;
    const service = new TaskPreflightService({
      resolver,
      getToolCatalog: () => CATALOG,
      getMemoryIndex: () => MEMORY,
      getSkillCatalog: () => SKILLS,
      getFallbackDefault: () => ({ providerId: 'cf-1', modelId: 'm', mode: '' }) as never,
    });
    const result = await service.run({ ...INPUT, fetchFn: okFetch(VALID_OUTPUT) });
    expect(result.status).toBe('ok');
    expect(result.seed?.profile).toBe('navigate');
    expect(result.seed?.sessionTitle).toBe('Corrigir autenticação de login');
  });

  it('generates a title through the configured preflight pipeline binding', async () => {
    const result = await makeService(makeBinding()).generateSessionTitle({
      userMessage: '<file_refs>ignore</file_refs> Corrija o erro de autenticação',
      fetchFn: okFetch('"Corrigir erro de autenticação."'),
    });
    expect(result.status).toBe('ok');
    expect(result.title).toBe('Corrigir erro de autenticação');
    expect(result.providerId).toBe('cf-1');
  });

  it('reports an unconfigured title pipeline without throwing', async () => {
    const result = await makeService(null).generateSessionTitle({ userMessage: 'corrija o login' });
    expect(result.status).toBe('unconfigured');
    expect(result.title).toBeUndefined();
  });

  it('runs with getSkillCatalog omitted (skill catalog falls back to empty)', async () => {
    const service = new TaskPreflightService({
      resolver: makeResolver(makeBinding()),
      getToolCatalog: () => CATALOG,
      getMemoryIndex: () => MEMORY,
      // getSkillCatalog intentionally omitted — exercises the optional-dep false branch
    });
    const result = await service.run({ ...INPUT, fetchFn: okFetch(VALID_OUTPUT) });
    expect(result.status).toBe('ok');
    expect(result.seed?.suggestedSkills).toBeUndefined();
  });

  it('returns ok with a validated seed (incl. suggested skills) on a clean response', async () => {
    const output = JSON.stringify({
      profile: 'navigate',
      tools: [{ name: 'read_file' }, { name: 'ext_srv__do_thing' }],
      skills: [{ id: 'api-collection', why: 'builds a client' }],
    });
    const result = await makeService(makeBinding()).run({ ...INPUT, fetchFn: okFetch(output) });
    expect(result.status).toBe('ok');
    expect(result.seed?.pinTools).toContain('ext_srv__do_thing');
    expect(result.seed?.suggestedSkills?.[0]?.id).toBe('api-collection');
    expect(result.seed?.suggestedSkills?.[0]?.evidence).toBe('project_scope');
  });

  it('filters a global discovery-only skill unless the prompt explicitly names it', async () => {
    const dsSkill = [{
      id: 'ds-ctx-ui',
      name: 'Design System: @corporate/ui',
      description: 'Components from @corporate/ui',
      namespace: 'builtin',
      scope: 'global',
      packageNames: ['@corporate/ui'],
      dependencyMatched: false,
    }];
    const output = JSON.stringify({
      profile: 'navigate',
      skills: [{ id: 'ds-ctx-ui', why: 'UI task' }],
    });
    const implicit = await makeService(makeBinding(), { getSkillCatalog: () => dsSkill }).run({
      ...INPUT,
      userMessage: 'mostre pagamentos pendentes na intranet',
      fetchFn: okFetch(output),
    });
    expect(implicit.seed?.suggestedSkills).toBeUndefined();

    const explicit = await makeService(makeBinding(), { getSkillCatalog: () => dsSkill }).run({
      ...INPUT,
      userMessage: 'use @corporate/ui para mostrar pagamentos pendentes',
      fetchFn: okFetch(output),
    });
    expect(explicit.seed?.suggestedSkills).toEqual([{
      id: 'ds-ctx-ui',
      reason: 'UI task',
      evidence: 'explicit',
    }]);
  });

  it('validates target projects and keeps project-scoped skills on the selected member', async () => {
    const workspaceProjects = [
      { projectId: 7, name: 'poa-backend', slug: 'poa-backend', rootPath: '/backend', isPrimary: true },
      { projectId: 11, name: 'poa-intranet-angular', slug: 'poa-intranet-angular', rootPath: '/intranet', isPrimary: false },
    ];
    const output = JSON.stringify({
      profile: 'navigate',
      projects: [{ slug: 'poa-intranet-angular', why: 'the task names intranet' }],
      skills: [{ id: 'api-collection', why: 'client work' }],
    });
    const service = makeService(makeBinding(), {
      getSkillCatalog: (_sessionId, projectId) => projectId === 11
        ? [{ ...SKILLS[0]!, scope: '11' }]
        : [],
    });
    const result = await service.run({
      ...INPUT,
      userMessage: 'ajuste a tela na intranet',
      isGlobalWorkspace: true,
      workspaceProjects,
      fetchFn: okFetch(output),
    });
    expect(result.seed?.targetProjects).toEqual([{
      slug: 'poa-intranet-angular',
      reason: 'the task names intranet',
    }]);
    expect(result.seed?.suggestedSkills?.[0]?.id).toBe('api-collection');
  });

  it('drops project-scoped skills when the selected global target is another project', async () => {
    const workspaceProjects = [
      { projectId: 7, name: 'poa-backend', slug: 'poa-backend', rootPath: '/backend', isPrimary: true },
      { projectId: 11, name: 'poa-intranet-angular', slug: 'poa-intranet-angular', rootPath: '/intranet', isPrimary: false },
    ];
    const service = makeService(makeBinding(), {
      getSkillCatalog: (_sessionId, projectId) => projectId === 7
        ? [{ ...SKILLS[0]!, scope: '7' }]
        : [],
    });
    const result = await service.run({
      ...INPUT,
      userMessage: 'ajuste a tela na intranet',
      isGlobalWorkspace: true,
      workspaceProjects,
      fetchFn: okFetch(JSON.stringify({
        profile: 'navigate',
        projects: [{ slug: 'poa-intranet-angular' }],
        skills: [{ id: 'api-collection' }],
      })),
    });
    expect(result.seed?.suggestedSkills).toBeUndefined();
  });

  it('changes the cache fingerprint when global workspace membership changes', () => {
    const service = makeService(makeBinding());
    const backend = { projectId: 7, name: 'backend', slug: 'backend', rootPath: '/backend', isPrimary: true };
    const intranet = { projectId: 11, name: 'intranet', slug: 'intranet', rootPath: '/intranet', isPrimary: false };
    const one = service.getCapabilityFingerprint({ ...INPUT, isGlobalWorkspace: true, workspaceProjects: [backend] });
    const two = service.getCapabilityFingerprint({ ...INPUT, isGlobalWorkspace: true, workspaceProjects: [backend, intranet] });
    expect(two).not.toBe(one);
  });

  it('omits Git capabilities even from a one-member global workspace', async () => {
    const project = { projectId: 7, name: 'backend', slug: 'backend', rootPath: '/backend', isPrimary: true };
    let prompt = '';
    const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
      prompt = String(init?.body ?? '');
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        profile: 'navigate',
        tools: [{ name: 'git_commit' }, { name: 'read_file' }],
      }) } }] }), { status: 200 });
    }) as typeof fetch;
    const result = await makeService(makeBinding()).run({
      ...INPUT,
      isGlobalWorkspace: true,
      workspaceProjects: [project],
      fetchFn,
    });
    expect(prompt).not.toContain('git_commit [');
    expect(result.seed?.pinTools).toEqual(['read_file']);
  });

  it('returns provider_error on a non-2xx response', async () => {
    const fetchFn = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    const result = await makeService(makeBinding()).run({ ...INPUT, fetchFn });
    expect(result.status).toBe('provider_error');
    expect(result.error).toContain('boom');
  });

  it('returns provider_error when the binding is missing credentials', async () => {
    const result = await makeService(makeBinding({ extra: {} })).run(INPUT);
    expect(result.status).toBe('provider_error');
    expect(result.error).toMatch(/account_id/);
  });

  it('returns timeout when the provider hangs (and never throws)', async () => {
    const hangingFetch = (() => new Promise(() => undefined)) as unknown as typeof fetch;
    const result = await makeService(makeBinding()).run({
      ...INPUT,
      fetchFn: hangingFetch,
      timeoutMs: 30,
    });
    expect(result.status).toBe('timeout');
    expect(result.error).toContain('30ms');
  });

  it('returns parse_fail (with raw preserved) on unparseable output', async () => {
    const result = await makeService(makeBinding()).run({
      ...INPUT,
      fetchFn: okFetch('I cannot help with that.'),
    });
    expect(result.status).toBe('parse_fail');
    expect(result.raw).toContain('I cannot help');
  });

  it('never throws even when the resolver itself blows up', async () => {
    const service = new TaskPreflightService({
      resolver: { resolveOrNull: async () => { throw new Error('db locked'); } } as unknown as PipelineProviderResolver,
      getToolCatalog: () => CATALOG,
      getMemoryIndex: () => MEMORY,
    });
    const result = await service.run(INPUT);
    expect(result.status).toBe('provider_error');
    expect(result.error).toContain('db locked');
  });
});
