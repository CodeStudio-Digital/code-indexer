/**
 * PipelineProviderResolver.resolveChain — the failover-chain builder. Pure
 * unit test with fake stores (no better-sqlite3 ABI dependency): verifies
 * the chain returns EVERY enabled binding at the first populated scope, in
 * priority order, with the general default appended, and that scopes never
 * merge (a reusable template override shadows global entirely).
 */
import { describe, expect, it } from 'vitest';
import type {
  PipelineProviderBinding,
  PipelineProviderBindingsStore,
} from '@mcp/store/pipeline-provider-bindings-store.js';
import type { ProviderConfig, ProviderStore } from '@mcp/store/provider-store.js';
import { PipelineBindingMissingError, PipelineProviderResolver } from '../provider-resolver.js';

type ScopeKey = string; // `${scopeType}:${scopeId}`

function row(over: Partial<PipelineProviderBinding>): PipelineProviderBinding {
  return {
    id: 1,
    pipeline_name: 'doc_ingest',
    binding_role: 'classifier',
    provider_id: 'p1',
    model_id: 'm',
    model_mode: '',
    config: {},
    scope_type: 'global',
    scope_id: null,
    enabled: true,
    priority: 0,
    created_at: '',
    updated_at: '',
    ...over,
  };
}

const PROVIDERS: Record<string, ProviderConfig> = {
  p1: { id: 'p1', kind: 'openai', name: 'p1', enabled: true } as ProviderConfig,
  p2: { id: 'p2', kind: 'openai', name: 'p2', enabled: true } as ProviderConfig,
  pDead: { id: 'pDead', kind: 'openai', name: 'pDead', enabled: false } as ProviderConfig,
  pFb: { id: 'pFb', kind: 'openrouter', name: 'pFb', enabled: true } as ProviderConfig,
};

function makeResolver(byScope: Record<ScopeKey, PipelineProviderBinding[]>): PipelineProviderResolver {
  const providerStore = {
    getProvider: (id: string) => PROVIDERS[id] ?? null,
    listProviders: ({ enabled }: { enabled?: boolean } = {}) =>
      Object.values(PROVIDERS).filter((p) => !enabled || p.enabled),
  } as unknown as ProviderStore;
  const bindingsStore = {
    findAllActiveAtScope: (o: { scopeType: string; scopeId: number | null }) =>
      byScope[`${o.scopeType}:${o.scopeId}`] ?? [],
  } as unknown as PipelineProviderBindingsStore;
  return new PipelineProviderResolver(bindingsStore, providerStore);
}

const FALLBACK = { providerKind: 'openrouter', modelId: 'fb-model' };

describe('resolveChain', () => {
  it('returns every enabled binding at global scope, priority order', async () => {
    const r = makeResolver({
      'global:null': [row({ id: 1, provider_id: 'p1' }), row({ id: 2, provider_id: 'p2' })],
    });
    const chain = await r.resolveChain('doc_ingest', 'classifier', {});
    expect(chain.map((c) => c.provider.id)).toEqual(['p1', 'p2']);
    expect(chain.every((c) => c.resolvedFrom === 'global')).toBe(true);
  });

  it('appends the general default as the last link (distinct provider)', async () => {
    const r = makeResolver({ 'global:null': [row({ id: 1, provider_id: 'p1' })] });
    const chain = await r.resolveChain('doc_ingest', 'classifier', {}, FALLBACK);
    expect(chain.map((c) => c.provider.id)).toEqual(['p1', 'pFb']);
    expect(chain.at(-1)?.resolvedFrom).toBe('fallback');
  });

  it('does not duplicate the fallback provider when already in the chain', async () => {
    const r = makeResolver({ 'global:null': [row({ id: 1, provider_id: 'pFb' })] });
    const chain = await r.resolveChain('doc_ingest', 'classifier', {}, { providerKind: 'openrouter', modelId: 'x' });
    expect(chain.map((c) => c.provider.id)).toEqual(['pFb']);
  });

  it('a template override shadows global entirely — no cross-scope merge', async () => {
    const r = makeResolver({
      'template:7': [row({ id: 9, provider_id: 'p2', scope_type: 'template', scope_id: 7 })],
      'global:null': [row({ id: 1, provider_id: 'p1' })],
    });
    const chain = await r.resolveChain('doc_ingest', 'classifier', { templateId: 7 });
    expect(chain.map((c) => c.provider.id)).toEqual(['p2']);
  });

  it('never probes a SQLite session scope when UUID session context is present', async () => {
    const queried: string[] = [];
    const providerStore = {
      getProvider: (id: string) => PROVIDERS[id] ?? null,
      listProviders: () => Object.values(PROVIDERS).filter((p) => p.enabled),
    } as unknown as ProviderStore;
    const bindingsStore = {
      findAllActiveAtScope: (o: { scopeType: string; scopeId: number | null }) => {
        queried.push(`${o.scopeType}:${o.scopeId}`);
        return o.scopeType === 'global' ? [row({ provider_id: 'p1' })] : [];
      },
    } as unknown as PipelineProviderBindingsStore;
    const r = new PipelineProviderResolver(bindingsStore, providerStore);

    const chain = await r.resolveChain('doc_ingest', 'classifier', {
      sessionId: '11111111-1111-4111-8111-111111111111',
      companySessionId: '22222222-2222-4222-8222-222222222222',
    });

    expect(chain.map((c) => c.provider.id)).toEqual(['p1']);
    expect(queried).toEqual(['global:null']);
  });

  it('a disabled top-priority provider no longer hides a healthy sibling', async () => {
    const r = makeResolver({
      'global:null': [
        row({ id: 1, provider_id: 'pDead', priority: 10 }),
        row({ id: 2, provider_id: 'p1', priority: 0 }),
      ],
    });
    const chain = await r.resolveChain('doc_ingest', 'classifier', {});
    expect(chain.map((c) => c.provider.id)).toEqual(['p1']);
  });

  it('empty when nothing is bound and no fallback given', async () => {
    const r = makeResolver({});
    expect(await r.resolveChain('doc_ingest', 'classifier', {})).toEqual([]);
  });
});

describe('resolve (delegates to chain[0])', () => {
  it('returns the first chain link', async () => {
    const r = makeResolver({
      'global:null': [row({ id: 1, provider_id: 'p1' }), row({ id: 2, provider_id: 'p2' })],
    });
    const b = await r.resolve('doc_ingest', 'classifier', {});
    expect(b.provider.id).toBe('p1');
  });

  it('throws PipelineBindingMissingError when the chain is empty', async () => {
    const r = makeResolver({});
    await expect(r.resolve('doc_ingest', 'classifier', {})).rejects.toBeInstanceOf(PipelineBindingMissingError);
  });
});
