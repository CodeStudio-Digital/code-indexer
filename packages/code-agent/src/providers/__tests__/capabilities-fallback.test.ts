/**
 * Tests for Phase E — smart fallback resolution in capabilities.ts.
 *
 * Two layers under test:
 *
 *   1. `inferContextWindow(model)` — pure family-heuristic. Detects the
 *      provider family by case-insensitive name pattern, then picks
 *      a representative window for that family + size variant.
 *
 *   2. `recordCapabilityFallback` / `getRecentCapabilityFallbacks` —
 *      in-memory ring-buffer of every model that resolved via heuristic
 *      OR hardcoded fallback. Powers the admin "models running with
 *      imprecise capabilities" view.
 *
 * Plus integration of both into `getEffectiveContextWindow`.
 *
 * The forensic case (session 763's `gpt-5.5` actually being in the
 * registry, not fallback) means the bug was elsewhere — but other
 * sessions on custom models WILL hit the new heuristic. These tests
 * lock the resolution table in place so a future "small tweak" doesn't
 * silently shift a whole family from 200K to 128K.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  inferContextWindow,
  recordCapabilityFallback,
  getRecentCapabilityFallbacks,
  clearCapabilityFallbacksForTest,
  getEffectiveContextWindow,
  resolveContextWindowWithSource,
  modelSupportsVision,
} from '../capabilities.js';

describe('modelSupportsVision', () => {
  it('uses input_modalities when present (reliable)', () => {
    expect(modelSupportsVision({ modelId: 'x', inputModalities: ['text', 'image'] })).toBe(true);
    expect(modelSupportsVision({ modelId: 'x', inputModalities: ['text'] })).toBe(false);
  });
  it('treats GLM / Z.AI as text-only (the reported bug)', () => {
    expect(modelSupportsVision({ providerKind: 'zai', modelId: 'glm-4.6' })).toBe(false);
    expect(modelSupportsVision({ providerKind: 'openai', modelId: 'glm-5.1' })).toBe(false);
  });
  it('treats deepseek as text-only', () => {
    expect(modelSupportsVision({ providerKind: 'deepseek', modelId: 'deepseek-chat' })).toBe(false);
  });
  it('treats claude / gpt-4o / gemini as vision-capable', () => {
    expect(modelSupportsVision({ providerKind: 'anthropic', modelId: 'claude-sonnet-4' })).toBe(true);
    expect(modelSupportsVision({ providerKind: 'openai', modelId: 'gpt-4o' })).toBe(true);
    expect(modelSupportsVision({ providerKind: 'gemini', modelId: 'gemini-2.0-flash' })).toBe(true);
  });
  it('returns undefined for unknown families (no surprise downgrade)', () => {
    expect(modelSupportsVision({ providerKind: 'mistral', modelId: 'mistral-large' })).toBeUndefined();
    expect(modelSupportsVision({ modelId: 'some-random-model' })).toBeUndefined();
  });
});

describe('inferContextWindow — Anthropic family', () => {
  it('claude-opus variants → 200k', () => {
    expect(inferContextWindow('claude-opus-4-7')?.window).toBe(200_000);
    expect(inferContextWindow('claude-opus-experimental')?.window).toBe(200_000);
    expect(inferContextWindow('claude-opus-4-7')?.via).toBe('family:anthropic-opus');
  });

  it('claude-sonnet variants → 200k', () => {
    expect(inferContextWindow('claude-sonnet-4-6')?.window).toBe(200_000);
    expect(inferContextWindow('claude-sonnet-2026-future')?.window).toBe(200_000);
    expect(inferContextWindow('claude-sonnet-4-6')?.via).toBe('family:anthropic-sonnet');
  });

  it('claude-haiku variants → 200k', () => {
    expect(inferContextWindow('claude-haiku-4-5')?.window).toBe(200_000);
    expect(inferContextWindow('claude-haiku-4-5')?.via).toBe('family:anthropic-haiku');
  });

  it('generic claude without size variant → 200k', () => {
    expect(inferContextWindow('claude-something-new')?.window).toBe(200_000);
    expect(inferContextWindow('claude-something-new')?.via).toBe('family:anthropic-generic');
  });

  it('anthropic vendor prefix → 200k', () => {
    expect(inferContextWindow('anthropic-custom-model')?.window).toBe(200_000);
  });
});

describe('inferContextWindow — Gemini family', () => {
  it('gemini-1.5-pro → 2M tokens', () => {
    expect(inferContextWindow('gemini-1.5-pro')?.window).toBe(2_097_152);
    expect(inferContextWindow('gemini-1.5-pro-latest')?.window).toBe(2_097_152);
    expect(inferContextWindow('gemini-1.5-pro')?.via).toBe('family:gemini-1.5-pro');
  });

  it('gemini-flash variants → 1M tokens', () => {
    expect(inferContextWindow('gemini-2.5-flash')?.window).toBe(1_048_576);
    expect(inferContextWindow('gemini-flash-experimental')?.window).toBe(1_048_576);
  });

  it('gemini-pro (non-1.5) → 1M tokens', () => {
    expect(inferContextWindow('gemini-2.5-pro')?.window).toBe(1_048_576);
  });

  it('generic gemini → 1M tokens', () => {
    expect(inferContextWindow('gemini-vnext')?.window).toBe(1_048_576);
    expect(inferContextWindow('gemini-vnext')?.via).toBe('family:gemini-generic');
  });
});

describe('inferContextWindow — OpenAI family', () => {
  it('gpt-5 line → 272k', () => {
    expect(inferContextWindow('gpt-5')?.window).toBe(272_000);
    expect(inferContextWindow('gpt-5.5')?.window).toBe(272_000);
    expect(inferContextWindow('gpt-5-mini-2026-04-15')?.window).toBe(272_000);
    expect(inferContextWindow('gpt-5')?.via).toBe('family:openai-gpt5');
  });

  it('gpt-4 line → 128k', () => {
    expect(inferContextWindow('gpt-4o')?.window).toBe(128_000);
    expect(inferContextWindow('gpt-4-turbo')?.window).toBe(128_000);
    expect(inferContextWindow('gpt-4o')?.via).toBe('family:openai-gpt4');
  });

  it('o1-mini / o3-mini reasoning models → 128k', () => {
    expect(inferContextWindow('o1-mini')?.window).toBe(128_000);
    expect(inferContextWindow('o3-mini')?.window).toBe(128_000);
    expect(inferContextWindow('o1-mini')?.via).toBe('family:openai-reasoning-mini');
  });

  it('o1 / o3 full-size reasoning → 200k', () => {
    expect(inferContextWindow('o1')?.window).toBe(200_000);
    expect(inferContextWindow('o3')?.window).toBe(200_000);
    expect(inferContextWindow('o1-pro')?.window).toBe(200_000);
    expect(inferContextWindow('o1')?.via).toBe('family:openai-reasoning');
  });

  it('chatgpt-* alias → openai-generic 128k', () => {
    expect(inferContextWindow('chatgpt-codex')?.window).toBe(128_000);
    expect(inferContextWindow('chatgpt-codex')?.via).toBe('family:openai-generic');
  });
});

describe('inferContextWindow — Z.AI / GLM family', () => {
  it('glm-5 variants → 200k', () => {
    expect(inferContextWindow('glm-5')?.window).toBe(200_000);
    expect(inferContextWindow('glm-5.1')?.window).toBe(200_000);
    expect(inferContextWindow('glm-5')?.via).toBe('family:zai-glm5');
  });

  it('glm-4.6 → 200k', () => {
    expect(inferContextWindow('glm-4.6')?.window).toBe(200_000);
  });

  it('older / generic glm → 128k', () => {
    expect(inferContextWindow('glm-4-air')?.window).toBe(128_000);
    expect(inferContextWindow('glm-4-32b')?.window).toBe(128_000);
    expect(inferContextWindow('glm-4-air')?.via).toBe('family:zai-generic');
  });
});

describe('inferContextWindow — DeepSeek', () => {
  it('v4 variants → 1M tokens', () => {
    expect(inferContextWindow('deepseek-v4-flash')?.window).toBe(1_000_000);
    expect(inferContextWindow('deepseek-v4-pro')?.window).toBe(1_000_000);
    expect(inferContextWindow('deepseek-v4-flash')?.via).toBe('family:deepseek-v4');
  });

  it('legacy deepseek → 128k', () => {
    expect(inferContextWindow('deepseek-coder')?.window).toBe(128_000);
    expect(inferContextWindow('deepseek-coder')?.via).toBe('family:deepseek-generic');
  });
});

describe('inferContextWindow — Kimi / Moonshot', () => {
  it('kimi-* → 200k', () => {
    expect(inferContextWindow('kimi-k2.6')?.window).toBe(200_000);
    expect(inferContextWindow('moonshot-v1-32k')?.window).toBe(200_000);
    expect(inferContextWindow('kimi-k2.6')?.via).toBe('family:moonshot-generic');
  });
});

describe('inferContextWindow — Mistral / Llama', () => {
  it('mistral / mixtral → 32k', () => {
    expect(inferContextWindow('mistral-large-2')?.window).toBe(32_000);
    expect(inferContextWindow('mixtral-8x22b')?.window).toBe(32_000);
  });

  it('llama / meta-llama → 128k', () => {
    expect(inferContextWindow('llama-3.3-70b')?.window).toBe(128_000);
    expect(inferContextWindow('meta-llama-4')?.window).toBe(128_000);
  });
});

describe('inferContextWindow — unrecognized models', () => {
  it('returns null for unknown family', () => {
    expect(inferContextWindow('completely-custom-model-x9')).toBeNull();
    expect(inferContextWindow('myorg-internal-1')).toBeNull();
  });

  it('handles empty / whitespace input', () => {
    expect(inferContextWindow('')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(inferContextWindow('CLAUDE-OPUS-4-7')?.window).toBe(200_000);
    expect(inferContextWindow('GPT-5')?.window).toBe(272_000);
    expect(inferContextWindow('Gemini-2.5-Flash')?.window).toBe(1_048_576);
  });
});

describe('recordCapabilityFallback — tracker', () => {
  beforeEach(() => clearCapabilityFallbacksForTest());

  it('records a new model with count 1', () => {
    recordCapabilityFallback({ model: 'foo-1', source: 'inferred', via: 'family:openai-gpt5', window: 272_000 });
    const list = getRecentCapabilityFallbacks();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      model: 'foo-1', source: 'inferred', via: 'family:openai-gpt5', window: 272_000, count: 1,
    });
  });

  it('increments count on duplicate model (no new entry)', () => {
    recordCapabilityFallback({ model: 'foo-1', source: 'inferred', via: 'family:openai-gpt5', window: 272_000 });
    recordCapabilityFallback({ model: 'foo-1', source: 'inferred', via: 'family:openai-gpt5', window: 272_000 });
    recordCapabilityFallback({ model: 'foo-1', source: 'inferred', via: 'family:openai-gpt5', window: 272_000 });
    const list = getRecentCapabilityFallbacks();
    expect(list).toHaveLength(1);
    expect(list[0].count).toBe(3);
  });

  it('updates via and window when the resolution changes for the same model', () => {
    recordCapabilityFallback({ model: 'shifty', source: 'inferred', via: 'family:anthropic-opus', window: 200_000 });
    recordCapabilityFallback({ model: 'shifty', source: 'fallback', via: 'hardcoded:128k', window: 128_000 });
    const list = getRecentCapabilityFallbacks();
    expect(list).toHaveLength(1);
    expect(list[0].source).toBe('fallback');
    expect(list[0].via).toBe('hardcoded:128k');
    expect(list[0].window).toBe(128_000);
    expect(list[0].count).toBe(2);
  });

  it('returns most-recent first (lastSeenAt descending)', async () => {
    recordCapabilityFallback({ model: 'a', source: 'inferred', via: 'v', window: 100_000 });
    await new Promise(r => setTimeout(r, 5));  // ensure distinct timestamps
    recordCapabilityFallback({ model: 'b', source: 'inferred', via: 'v', window: 100_000 });
    await new Promise(r => setTimeout(r, 5));
    recordCapabilityFallback({ model: 'a', source: 'inferred', via: 'v', window: 100_000 });
    const list = getRecentCapabilityFallbacks();
    expect(list[0].model).toBe('a');  // updated more recently
    expect(list[1].model).toBe('b');
  });

  it('caps at FALLBACK_TRACKER_MAX (100) — evicts oldest entry', () => {
    // Insert 105 distinct models; expect 100 retained.
    for (let i = 0; i < 105; i++) {
      recordCapabilityFallback({ model: `m${i}`, source: 'inferred', via: 'v', window: 100_000 });
    }
    const list = getRecentCapabilityFallbacks();
    expect(list.length).toBe(100);
    const models = new Set(list.map(e => e.model));
    expect(models.has('m0')).toBe(false);
    expect(models.has('m4')).toBe(false);
    expect(models.has('m5')).toBe(true);   // oldest survivor
    expect(models.has('m104')).toBe(true); // newest
  });
});

describe('getEffectiveContextWindow — integration with fallback chain', () => {
  beforeEach(() => clearCapabilityFallbacksForTest());

  it('registry-resolved model: source=registry, isFallback=false, no tracker entry', () => {
    // gpt-5.5 is in the prefix fallback table → 272k
    const r = getEffectiveContextWindow('gpt-5.5');
    expect(r.window).toBe(272_000);
    expect(r.isFallback).toBe(false);
    expect(r.source).toBe('registry');
    expect(getRecentCapabilityFallbacks()).toHaveLength(0);
  });

  it('inferred model: source=inferred, isFallback=true, tracker records the via', () => {
    // Unknown variant that matches the family heuristic
    const r = getEffectiveContextWindow('claude-mysterious-99');
    expect(r.window).toBe(200_000);   // anthropic-generic
    expect(r.isFallback).toBe(true);
    expect(r.source).toBe('inferred');
    expect(r.via).toBe('family:anthropic-generic');
    const list = getRecentCapabilityFallbacks();
    expect(list).toHaveLength(1);
    expect(list[0].model).toBe('claude-mysterious-99');
    expect(list[0].source).toBe('inferred');
  });

  it('truly unknown model: source=fallback, isFallback=true, via=hardcoded:128k', () => {
    const r = getEffectiveContextWindow('totally-custom-thing');
    expect(r.window).toBe(128_000);
    expect(r.isFallback).toBe(true);
    expect(r.source).toBe('fallback');
    expect(r.via).toBe('hardcoded:128k');
    const list = getRecentCapabilityFallbacks();
    expect(list).toHaveLength(1);
    expect(list[0].source).toBe('fallback');
  });

  it('reserves output and computes effective window for inferred models', () => {
    const r = getEffectiveContextWindow('claude-mysterious-99');
    expect(r.reservedOutput).toBeGreaterThan(0);
    expect(r.effective).toBe(r.window - r.reservedOutput);
  });
});

// ─── Phase F — resolveContextWindowWithSource ──────────────────────────────

describe('resolveContextWindowWithSource — Phase F admin backfill helper', () => {
  it('reports registry-exact for models that have an exact MODEL_REGISTRY entry', () => {
    const r = resolveContextWindowWithSource('gpt-5.5');
    expect(r.source).toBe('registry-exact');
    expect(r.window).toBe(272_000);
    expect(r.via).toBe('registry:gpt-5.5');
  });

  it('reports registry-prefix when only a prefix entry matches', () => {
    // gpt-5.5-2026-04-15 isn't in MODEL_REGISTRY exactly, but matches `gpt-5.5` prefix.
    const r = resolveContextWindowWithSource('gpt-5.5-2026-04-15');
    expect(r.source).toBe('registry-prefix');
    expect(r.window).toBe(272_000);
    expect(r.via).toBe('prefix:gpt-5.5');
  });

  it('reports inferred when neither exact nor prefix matches but family heuristic does', () => {
    const r = resolveContextWindowWithSource('claude-mysterious-future');
    expect(r.source).toBe('inferred');
    expect(r.window).toBe(200_000);
    expect(r.via).toBe('family:anthropic-generic');
  });

  it('reports fallback for completely unknown models', () => {
    const r = resolveContextWindowWithSource('myorg-completely-custom-x9');
    expect(r.source).toBe('fallback');
    expect(r.window).toBe(128_000);
    expect(r.via).toBe('hardcoded:128k');
  });

  it('handles empty input as fallback', () => {
    const r = resolveContextWindowWithSource('');
    expect(r.source).toBe('fallback');
    expect(r.via).toBe('hardcoded:empty-model-id');
  });

  it('does NOT touch the in-memory fallback tracker (pure read)', () => {
    clearCapabilityFallbacksForTest();
    resolveContextWindowWithSource('something-unknown');
    resolveContextWindowWithSource('claude-mysterious-99');
    // resolveContextWindowWithSource is read-only; tracker only records via
    // getEffectiveContextWindow at runtime, not via the admin helper.
    expect(getRecentCapabilityFallbacks()).toHaveLength(0);
  });

  it('treats fallback as the lookup`s null-equivalent (admin backfill predicate)', () => {
    // Admin backfill code does `if (source !== 'fallback') save(window)`.
    // Verify that pattern works for all four source values.
    const cases = [
      { model: 'gpt-5.5', shouldSave: true },        // registry-exact
      { model: 'gpt-5.5-2026', shouldSave: true },    // registry-prefix
      { model: 'claude-experimental', shouldSave: true }, // inferred
      { model: 'totally-custom-blah', shouldSave: false }, // fallback
    ];
    for (const c of cases) {
      const r = resolveContextWindowWithSource(c.model);
      expect(r.source !== 'fallback', `${c.model} (source=${r.source})`).toBe(c.shouldSave);
    }
  });
});
