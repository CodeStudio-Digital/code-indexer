/**
 * Unit tests for the pure lexical scorer behind `find_tools`.
 * See find-tools.test.ts for ranking-quality tests against the real registry
 * and find-tools-params.test.ts for the argument-name discovery end-to-end.
 */
import { describe, it, expect } from 'vitest';
import {
  bestHit,
  getToolText,
  passesStrict,
  scoreTool,
  tokenizeQuery,
  topLevelParams,
} from '../find-tools-score.js';

describe('tokenizeQuery', () => {
  it('normalizes Portuguese accents and preserves Unicode words', () => {
    expect(tokenizeQuery('buscar referências no arquivo')).toEqual(['search', 'references', 'file']);
    expect(tokenizeQuery('código 日本語')).toEqual(['codigo', '日本語']);
    const score = scoreTool(tokenizeQuery('ler arquivo'), getToolText({ name: 'read_file' }));
    expect(score.hitCount).toBe(2);
  });
  it('dedups repeated tokens and preserves first-seen order', () => {
    expect(tokenizeQuery('evolution_id product evolution create')).toEqual([
      'evolution', 'id', 'product', 'create',
    ]);
  });

  it('drops stopwords and 1-char tokens', () => {
    expect(tokenizeQuery('use the tool to edit a file')).toEqual(['edit', 'file']);
  });

  it('falls back to raw deduped tokens when everything is a stopword', () => {
    expect(tokenizeQuery('can you use any')).toEqual(['can', 'you', 'use', 'any']);
  });

  it('caps at 12 distinct tokens', () => {
    const query = Array.from({ length: 20 }, (_, i) => `word${i}`).join(' ');
    expect(tokenizeQuery(query)).toHaveLength(12);
  });
});

describe('topLevelParams', () => {
  const schema = {
    type: 'object',
    properties: {
      evolution_id: { type: 'number', description: 'Evolution to attach the draft to.' },
      title: { type: ['string', 'null'] },
      spec: {
        type: 'object',
        description: 'The COMPLETE refined AppSpec.',
        properties: { screens: { type: 'array' }, name: { type: 'string' } },
      },
    },
    required: ['spec'],
  };

  it('extracts names, parts, required flags, and type labels', () => {
    const params = topLevelParams(schema);
    expect(params.map((p) => p.name)).toEqual(['evolution_id', 'title', 'spec']);
    const evo = params[0];
    expect(evo.parts).toEqual(['evolution', 'id']);
    expect(evo.required).toBe(false);
    expect(evo.typeLabel).toBe('number');
    expect(evo.descWords).toContain('draft');
    expect(params[1].typeLabel).toBe('string|null');
    expect(params[2].required).toBe(true);
  });

  it('does NOT recurse into nested schemas (App Studio spec guard)', () => {
    const params = topLevelParams(schema);
    expect(params.map((p) => p.name)).not.toContain('screens');
    // Nested property words are invisible to the scorer.
    const text = getToolText({ name: 'app_save_spec', parameters: schema });
    expect(bestHit('screens', text)).toBeNull();
  });

  it('tolerates malformed schemas', () => {
    expect(topLevelParams(undefined)).toEqual([]);
    expect(topLevelParams({ type: 'object' })).toEqual([]);
    expect(topLevelParams({ properties: [] })).toEqual([]);
    expect(topLevelParams({ properties: { a: true }, required: 'a' })).toEqual([
      { name: 'a', parts: ['a'], required: false, typeLabel: 'any', descWords: [] },
    ]);
  });
});

describe('bestHit — weight table', () => {
  const text = getToolText({
    name: 'spawn_agent',
    description: 'Spawn agents to run tasks in parallel. Each one creates a context window.',
    parameters: {
      type: 'object',
      properties: {
        evolution_id: { type: 'number', description: 'Target evolution for the draft.' },
      },
    },
  });

  it('name part exact beats everything (5)', () => {
    expect(bestHit('spawn', text)).toEqual({ weight: 5, field: 'name' });
  });

  it('param part exact scores 4 and carries the param name', () => {
    expect(bestHit('evolution', text)).toEqual({ weight: 4, field: 'param', param: 'evolution_id' });
    expect(bestHit('id', text)).toEqual({ weight: 4, field: 'param', param: 'evolution_id' });
  });

  it('name part prefix scores 3; token-extends-part needs a >=4-char part', () => {
    expect(bestHit('agents', text)).toEqual({ weight: 3, field: 'name' }); // agent→agents
    expect(bestHit('spa', text)).toEqual({ weight: 3, field: 'name' }); // spa→spawn
    // "approval" extending the 3-char part "app" is coincidence, not morphology.
    const appTool = getToolText({ name: 'app_get_spec', description: 'Read the current AppSpec.' });
    expect(bestHit('approval', appTool)).toBeNull();
  });

  it('full-name substring scores 2', () => {
    const sub = getToolText({ name: 'subagent', description: '' });
    expect(bestHit('agent', sub)).toEqual({ weight: 2, field: 'name' });
  });

  it('description word hits are word-boundary + prefix >=4: "id" cannot hit "provide"', () => {
    const t = getToolText({ name: 'other_tool', description: 'We provide a wide feature set.' });
    expect(bestHit('id', t)).toBeNull();
    expect(bestHit('provide', t)).toEqual({ weight: 2, field: 'desc' });
    // Prefix-tolerant both ways: create→creates, parallelize→parallel.
    expect(bestHit('create', text)).toEqual({ weight: 2, field: 'desc' });
    expect(bestHit('parallelize', text)).toEqual({ weight: 2, field: 'desc' });
  });

  it('param-description word is the weakest signal (1)', () => {
    expect(bestHit('draft', text)).toEqual({ weight: 1, field: 'param-desc' });
  });

  it('misses return null', () => {
    expect(bestHit('kubernetes', text)).toBeNull();
  });
});

describe('scoreTool + passes', () => {
  const text = getToolText({
    name: 'app_propose_spec_revision',
    description: 'Create a reviewable draft spec revision for an App Studio evolution.',
    parameters: {
      type: 'object',
      properties: { evolution_id: { type: 'number' }, title: { type: 'string' } },
    },
  });

  it('2-char param parts score but never anchor ("id" guard)', () => {
    const s = scoreTool(['id'], text);
    expect(s.total).toBe(4);
    expect(s.hasAnchor).toBe(false);
    expect(passesStrict(s, 1, 0.5)).toBe(false);
  });

  it('the evolution_id query anchors via the param and passes strict', () => {
    const tokens = tokenizeQuery('evolution_id product evolution create');
    const s = scoreTool(tokens, text);
    expect(s.hitCount).toBe(3); // evolution, id, create — "product" misses
    expect(s.hasAnchor).toBe(true);
    expect(s.matchedParams).toEqual(['evolution_id']);
    expect(s.nameHit).toBe(false);
    expect(passesStrict(s, tokens.length, 0.5)).toBe(true);
  });

  it('full-coverage description-only match passes strict on >=3 tokens', () => {
    const s = scoreTool(['reviewable', 'draft', 'studio'], text);
    expect(s.hasAnchor).toBe(false);
    expect(passesStrict(s, 3, 0.5)).toBe(true); // impossible under the old scorer
    // ...but not on shorter queries, where one incidental word could qualify.
    const single = scoreTool(['reviewable'], text);
    expect(passesStrict(single, 1, 0.5)).toBe(false);
  });
});
