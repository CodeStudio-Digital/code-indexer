/**
 * Task-preflight unit tests — no SQLite, no real LLM. The resolver is a
 * stub object and the provider call is intercepted via `fetchFn`, so the
 * suite runs ABI-free.
 */
import { describe, expect, it } from 'vitest';
import type { PipelineProviderResolver, ResolvedBinding } from '../../../pipelines/index.js';
import { TaskPreflightService } from '../preflight-pipeline.js';
import { buildPreflightMessages, parsePreflightOutput } from '../preflight-prompt.js';

const CATALOG = [
  { name: 'read_file', tier: 'bootstrap', description: 'Read file contents' },
  { name: 'edit_file', tier: 'navigate', description: 'Find/replace edit' },
  { name: 'mcp__search', tier: 'bootstrap', description: 'Hybrid search' },
  { name: 'git_commit', tier: 'admin' },
];
const MEMORY = [
  { title: 'Auth token refresh gotcha', category: 'gotcha', excerpt: 'refresh expires in 25min' },
  { title: 'API error envelope', category: 'convention' },
];
const PARSE_CTX = {
  toolNames: new Set(CATALOG.map((t) => t.name)),
  memoryTitles: MEMORY.map((m) => m.title),
  maxTools: 3,
  maxMemories: 2,
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

function makeService(binding: ResolvedBinding | null): TaskPreflightService {
  return new TaskPreflightService({
    resolver: makeResolver(binding),
    getToolCatalog: () => CATALOG,
    getMemoryIndex: () => MEMORY,
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
  task_kind: 'bugfix',
  profile: 'navigate',
  tools: [{ name: 'read_file', why: 'inspect' }, { name: 'edit_file', why: 'fix' }],
  memories: [{ title: 'auth token refresh GOTCHA', why: 'same login flow' }],
});

describe('parsePreflightOutput', () => {
  it('parses clean JSON and canonicalizes memory titles case-insensitively', () => {
    const seed = parsePreflightOutput(VALID_OUTPUT, PARSE_CTX);
    expect(seed).toEqual({
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

  it('returns null for garbage, arrays, and empty-after-validation outputs', () => {
    expect(parsePreflightOutput('not json at all', PARSE_CTX)).toBeNull();
    expect(parsePreflightOutput('[1,2,3]', PARSE_CTX)).toBeNull();
    expect(parsePreflightOutput(JSON.stringify({ tools: [{ name: 'nope' }] }), PARSE_CTX)).toBeNull();
  });
});

describe('buildPreflightMessages', () => {
  it('includes task + catalog, omits memory_index when empty, truncates long tasks', () => {
    const long = 'x'.repeat(2500);
    const messages = buildPreflightMessages({
      userMessage: long,
      toolCatalog: CATALOG,
      memoryIndex: [],
      maxTools: 12,
      maxMemories: 5,
    });
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).toContain('AT MOST 12 tools');
    const user = messages[1]!.content;
    expect(user).toContain('<task>');
    expect(user).toContain('...[truncated]');
    expect(user).toContain('read_file [bootstrap] Read file contents');
    expect(user).not.toContain('<memory_index>');
  });

  it('renders the memory index with category and excerpt', () => {
    const user = buildPreflightMessages({
      userMessage: 'fix login',
      toolCatalog: CATALOG,
      memoryIndex: MEMORY,
      maxTools: 12,
      maxMemories: 5,
    })[1]!.content;
    expect(user).toContain('<memory_index>');
    expect(user).toContain('- [gotcha] Auth token refresh gotcha — "refresh expires in 25min"');
    expect(user).toContain('- [convention] API error envelope');
  });
});

describe('TaskPreflightService.run', () => {
  const INPUT = { sessionId: 1, projectId: 7, userMessage: 'corrija o bug de login' };

  it('returns unconfigured when no binding resolves', async () => {
    const result = await makeService(null).run(INPUT);
    expect(result.status).toBe('unconfigured');
    expect(result.seed).toBeUndefined();
  });

  it('returns ok with a validated seed on a clean response', async () => {
    const result = await makeService(makeBinding()).run({ ...INPUT, fetchFn: okFetch(VALID_OUTPUT) });
    expect(result.status).toBe('ok');
    expect(result.seed?.profile).toBe('navigate');
    expect(result.seed?.pinTools).toEqual(['read_file', 'edit_file']);
    expect(result.providerId).toBe('cf-1');
    expect(result.resolvedFrom).toBe('global');
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
