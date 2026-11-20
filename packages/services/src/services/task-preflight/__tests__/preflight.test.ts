/**
 * Task-preflight unit tests — no SQLite, no real LLM. The resolver is a
 * stub object and the provider call is intercepted via `fetchFn`, so the
 * suite runs ABI-free.
 */
import { describe, expect, it, vi } from 'vitest';
import { preparePreflightCatalogs } from '../preflight-context.js';
import { asSessionId } from '@mcp/session-storage';

it('omits memory from preflight before loading titles when the user opts out', () => {
  const getMemoryIndex = vi.fn(() => [{ title: 'Private convention' }]);
  const catalogs = preparePreflightCatalogs({ getMemoryIndex }, {
    projectId: 1, sessionId: asSessionId('00000000-0000-4000-8000-000000000001'),
    userMessage: 'Ignore project memory during this task',
  });
  expect(getMemoryIndex).not.toHaveBeenCalled();
  expect(catalogs.memoryIndex).toEqual([]);
});
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

const MEMORY = [
  { title: 'Auth token refresh gotcha', category: 'gotcha', excerpt: 'refresh expires in 25min' },
  { title: 'API error envelope', category: 'convention' },
];
const SKILLS = [
  { id: 'api-collection', description: 'Build or import an HTTP API client collection', namespace: 'builtin', scope: '7' },
  { id: 'qa-playwright', description: 'Author Playwright E2E tests', namespace: 'builtin', scope: '7' },
  { id: 'api-docs', description: 'Generate API documentation', namespace: 'builtin', scope: '7' },
  { id: 'init', description: 'Initialize a CLAUDE.md for the repo', namespace: 'builtin', scope: '7' },
];
const PARSE_CTX = {
  memoryTitles: MEMORY.map((m) => m.title),
  skillIds: new Set(SKILLS.map((s) => s.id)),
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
  tools: [{ name: 'read_file', why: 'inspect' }, { name: 'edit_file', why: 'fix' }], // legacy field, ignored
  memories: [{ title: 'auth token refresh GOTCHA', why: 'same login flow' }],
});

describe('parsePreflightOutput', () => {
  it('parses clean JSON and canonicalizes memory titles case-insensitively', () => {
    const seed = parsePreflightOutput(VALID_OUTPUT, PARSE_CTX);
    expect(seed).toEqual({
      sessionTitle: 'Corrigir autenticação de login',
      profile: 'navigate',
      taskKind: 'bugfix',
      memories: [{ title: 'Auth token refresh gotcha', reason: 'same login flow' }],
    });
  });

  it('parses fenced and prose-wrapped JSON', () => {
    expect(parsePreflightOutput('```json\n' + VALID_OUTPUT + '\n```', PARSE_CTX)).not.toBeNull();
    expect(parsePreflightOutput(`Sure! Here you go: ${VALID_OUTPUT} hope it helps`, PARSE_CTX)).not.toBeNull();
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
      skills: ['api-collection', 'api-collection', 'qa-playwright', 'api-docs'],
    });
    const seed = parsePreflightOutput(raw, PARSE_CTX);
    expect(seed?.suggestedSkills?.map((s) => s.id)).toEqual(['api-collection', 'qa-playwright']);
  });

  it('clamps skills to the shipped cap (3) when more valid ids are returned', () => {
    // Pins the production MAX_SKILLS=3 (preflight-pipeline.ts) end of the clamp.
    const ctx3 = { ...PARSE_CTX, maxSkills: 3 };
    const raw = JSON.stringify({ skills: ['api-collection', 'qa-playwright', 'api-docs', 'init'] });
    const seed = parsePreflightOutput(raw, ctx3);
    expect(seed?.suggestedSkills?.map((s) => s.id)).toEqual(['api-collection', 'qa-playwright', 'api-docs']);
  });

  it('a skills-only seed is usable (not null)', () => {
    const seed = parsePreflightOutput(JSON.stringify({ skills: ['api-collection'] }), PARSE_CTX);
    expect(seed).not.toBeNull();
    expect(seed?.suggestedSkills?.[0]?.id).toBe('api-collection');
  });

  it('rejects a valid skill id when deterministic evidence is absent', () => {
    const seed = parsePreflightOutput(JSON.stringify({ skills: ['api-collection'] }), {
      ...PARSE_CTX,
      skillMetaById: new Map([['api-collection', { evidence: undefined }]]),
    });
    expect(seed).toBeNull();
  });

  it('drops unknown memory titles', () => {
    const raw = JSON.stringify({
      profile: 'navigate',
      memories: [{ title: 'Invented memory', why: 'x' }],
    });
    const seed = parsePreflightOutput(raw, PARSE_CTX);
    expect(seed?.profile).toBe('navigate');
    expect(seed?.memories).toBeUndefined();
  });

  it('invalid profile/task_kind fail independently without killing the seed', () => {
    const raw = JSON.stringify({ profile: 'god-mode', task_kind: 'wat', session_title: 'Fix login' });
    const seed = parsePreflightOutput(raw, PARSE_CTX);
    expect(seed?.profile).toBeUndefined();
    expect(seed?.taskKind).toBeUndefined();
    expect(seed?.sessionTitle).toBe('Fix login');
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
  it('includes the task, omits skill/memory blocks when empty, truncates long tasks', () => {
    const long = 'x'.repeat(2500);
    const messages = buildPreflightMessages({
      userMessage: long,
      memoryIndex: [],
      skillCatalog: [],
      maxMemories: 5,
      maxSkills: 3,
    });
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).toContain('AT MOST 3 skills');
    expect(messages[0]!.content).toContain('session_title');
    const user = messages[1]!.content;
    expect(user).toContain('<task>');
    expect(user).toContain('...[truncated]');
    expect(user).not.toContain('<memory_index>');
    expect(user).not.toContain('<skill_catalog>');
  });

  it('renders the memory index and skill catalog when present', () => {
    const user = buildPreflightMessages({
      userMessage: 'fix login',
      memoryIndex: MEMORY,
      skillCatalog: SKILLS,
      maxMemories: 5,
      maxSkills: 3,
    })[1]!.content;
    expect(user).toContain('<memory_index>');
    expect(user).toContain('- [gotcha; source=unknown] Auth token refresh gotcha — "refresh expires in 25min"');
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
      skills: [{ id: 'api-collection', why: 'builds a client' }],
    });
    const result = await makeService(makeBinding()).run({ ...INPUT, fetchFn: okFetch(output) });
    expect(result.status).toBe('ok');
    expect(result.seed?.suggestedSkills?.[0]?.id).toBe('api-collection');
    expect(result.seed?.suggestedSkills?.[0]?.evidence).toBe('project_scope');
  });

  it('filters a global discovery-only skill unless the prompt explicitly names it', async () => {
    const packageSkill = [{
      id: 'charts-context',
      name: 'Chart library: @corporate/charts',
      description: 'Components from @corporate/charts',
      namespace: 'builtin',
      scope: 'global',
      packageNames: ['@corporate/charts'],
      dependencyMatched: false,
    }];
    const output = JSON.stringify({
      profile: 'navigate',
      skills: [{ id: 'charts-context', why: 'chart task' }],
    });
    const implicit = await makeService(makeBinding(), { getSkillCatalog: () => packageSkill }).run({
      ...INPUT,
      userMessage: 'mostre pagamentos pendentes na intranet',
      fetchFn: okFetch(output),
    });
    expect(implicit.seed?.suggestedSkills).toBeUndefined();

    const explicit = await makeService(makeBinding(), { getSkillCatalog: () => packageSkill }).run({
      ...INPUT,
      userMessage: 'use @corporate/charts para mostrar pagamentos pendentes',
      fetchFn: okFetch(output),
    });
    expect(explicit.seed?.suggestedSkills).toEqual([{
      id: 'charts-context',
      reason: 'chart task',
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

  it('lists no tools, Git included, even for a one-member global workspace', async () => {
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
    expect(prompt).not.toContain('git_commit');
    expect(prompt).not.toContain('<tool_catalog>');
    expect(result.seed).toEqual({ profile: 'navigate' });
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
        getMemoryIndex: () => MEMORY,
    });
    const result = await service.run(INPUT);
    expect(result.status).toBe('provider_error');
    expect(result.error).toContain('db locked');
  });
});

describe('preflight without tool pins', () => {
  const NO_TOOLS_CTX = {
    memoryTitles: MEMORY.map((m) => m.title),
    skillIds: new Set(SKILLS.map((s) => s.id)),
    maxMemories: 2,
    maxSkills: 2,
  };

  it('sends no tool catalog and asks for no tools', () => {
    const [system, user] = buildPreflightMessages({
      userMessage: 'fix login',
      memoryIndex: MEMORY,
      skillCatalog: SKILLS,
      maxMemories: 3,
      maxSkills: 3,
    } as Parameters<typeof buildPreflightMessages>[0]);
    expect(user!.content).not.toContain('<tool_catalog>');
    expect(system!.content).not.toMatch(/"tools"|tool catalog|\btools the agent\b/i);
    for (const field of ['session_title', 'task_kind', 'profile', 'projects', 'skills', 'memories']) {
      expect(system!.content).toContain(`"${field}"`);
    }
  });

  it('ignores a tools field in the analyzer answer', () => {
    const seed = parsePreflightOutput(JSON.stringify({
      profile: 'navigate',
      tools: [{ name: 'read_file', why: 'inspect' }],
    }), NO_TOOLS_CTX as Parameters<typeof parsePreflightOutput>[1]);
    expect(seed).toEqual({ profile: 'navigate' });
  });

  it('does not count a tools-only answer as a usable seed', () => {
    expect(parsePreflightOutput(JSON.stringify({ tools: ['read_file'] }), NO_TOOLS_CTX as Parameters<typeof parsePreflightOutput>[1])).toBeNull();
  });

  it('runs without a tool catalog dependency', async () => {
    const svc = new TaskPreflightService({
      resolver: makeResolver(makeBinding()),
      getMemoryIndex: () => MEMORY,
      getSkillCatalog: () => SKILLS,
    } as TaskPreflightDeps);
    const result = await svc.run({
      sessionId: asSessionId('00000000-0000-4000-8000-000000000009'),
      projectId: 7,
      userMessage: 'corrija o bug de login',
      fetchFn: okFetch(JSON.stringify({ task_kind: 'bugfix', profile: 'navigate', tools: ['read_file'] })),
    });
    expect(result.status).toBe('ok');
    expect(result.seed).toEqual({ taskKind: 'bugfix', profile: 'navigate' });
  });
});
