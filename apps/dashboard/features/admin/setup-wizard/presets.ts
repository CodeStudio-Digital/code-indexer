/**
 * Layperson setup presets + the heuristics that resolve them against the
 * providers a user actually has configured.
 *
 * A preset is a free-first suggestion per capability bucket. The wizard
 * resolves each suggestion to a real (provider, model) at runtime; when the
 * suggested model isn't in the provider's enabled list it leaves the model
 * empty so the user picks one ("pedir interação" — no silent guessing).
 */
import type { CapabilityKind } from '../pipeline-bindings-api.js';
import type { AdminModel, AdminProvider } from '../types.js';

export type PresetId = 'economy' | 'balanced' | 'premium';

export interface PresetBucketHint { providerKind: string; modelHint: string }

export interface Preset {
  id: PresetId;
  /** Optional buckets switched ON by default for this preset. */
  optionalOn: CapabilityKind[];
  buckets: Partial<Record<CapabilityKind, PresetBucketHint>>;
}

/** Which capability buckets each provider KIND can serve (no per-model probing). */
const PROVIDER_CAPABILITIES: Record<string, CapabilityKind[]> = {
  cloudflare:     ['text_llm', 'embeddings', 'reranking', 'vision'],
  openai:         ['text_llm', 'embeddings', 'reranking', 'vision', 'voice', 'autocomplete'],
  chatgpt:        ['text_llm', 'reranking', 'vision', 'autocomplete'],
  gemini:         ['text_llm', 'embeddings', 'reranking', 'vision', 'voice'],
  'google-oauth': ['text_llm', 'reranking', 'vision', 'voice'],
  anthropic:      ['text_llm', 'reranking', 'vision'],
  'claude-code':  ['text_llm', 'reranking', 'vision'],
  deepseek:       ['text_llm', 'reranking', 'autocomplete'],
  zai:            ['text_llm', 'reranking'],
  moonshot:       ['text_llm', 'reranking'],
  'kimi-code':    ['text_llm', 'reranking'],
  openrouter:     ['text_llm', 'reranking', 'vision'],
  copilot:        ['text_llm', 'reranking', 'autocomplete'],
  bedrock:        ['text_llm', 'embeddings', 'reranking', 'vision'],
};

/** Whether a provider kind can serve a capability bucket (default: chat-only). */
export function providerSupports(kind: CapabilityKind, providerKind: string): boolean {
  return (PROVIDER_CAPABILITIES[providerKind] ?? ['text_llm', 'reranking']).includes(kind);
}

export const PRESETS: Preset[] = [
  {
    id: 'economy',
    optionalOn: [],
    buckets: {
      text_llm:   { providerKind: 'cloudflare', modelHint: '@cf/meta/llama-3.1-8b-instruct' },
      embeddings: { providerKind: 'cloudflare', modelHint: '@cf/baai/bge-m3' },
      reranking:  { providerKind: 'cloudflare', modelHint: '@cf/meta/llama-3.1-8b-instruct' },
    },
  },
  {
    id: 'balanced',
    optionalOn: ['vision'],
    buckets: {
      text_llm:     { providerKind: 'openai',     modelHint: 'gpt-4o-mini' },
      embeddings:   { providerKind: 'cloudflare',  modelHint: '@cf/baai/bge-m3' },
      reranking:    { providerKind: 'openai',     modelHint: 'gpt-4o-mini' },
      vision:       { providerKind: 'openai',     modelHint: 'gpt-4o-mini' },
      voice:        { providerKind: 'openai',     modelHint: 'whisper-1' },
      autocomplete: { providerKind: 'deepseek',   modelHint: 'deepseek-coder' },
    },
  },
  {
    id: 'premium',
    optionalOn: ['vision', 'voice', 'autocomplete'],
    buckets: {
      text_llm:     { providerKind: 'anthropic',  modelHint: 'claude-sonnet-4' },
      embeddings:   { providerKind: 'cloudflare', modelHint: '@cf/baai/bge-m3' },
      reranking:    { providerKind: 'anthropic',  modelHint: 'claude-sonnet-4' },
      vision:       { providerKind: 'openai',     modelHint: 'gpt-4o' },
      voice:        { providerKind: 'openai',     modelHint: 'whisper-1' },
      autocomplete: { providerKind: 'deepseek',   modelHint: 'deepseek-coder' },
    },
  },
];

export function presetById(id: PresetId): Preset {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[0];
}

/** Pick a configured provider for a bucket: exact kind → free Cloudflare → any. */
export function pickProvider(
  kind: CapabilityKind,
  hint: PresetBucketHint | undefined,
  providers: AdminProvider[],
): AdminProvider | null {
  const eligible = providers.filter((p) => providerSupports(kind, p.kind));
  if (hint) {
    const exact = eligible.find((p) => p.kind === hint.providerKind);
    if (exact) return exact;
  }
  if (kind === 'embeddings' || kind === 'reranking') {
    const cf = eligible.find((p) => p.kind === 'cloudflare');
    if (cf) return cf;
  }
  return eligible[0] ?? null;
}

/** Resolve a model hint to a real enabled model id, or '' if not present. */
export function pickModel(hint: PresetBucketHint | undefined, models: AdminModel[]): string {
  const ids = models.map((m) => m.model_id);
  if (hint && ids.includes(hint.modelHint)) return hint.modelHint;
  if (hint) {
    const partial = models.find(
      (m) => m.model_id.includes(hint.modelHint) || hint.modelHint.includes(m.model_id),
    );
    if (partial) return partial.model_id;
  }
  return '';
}
