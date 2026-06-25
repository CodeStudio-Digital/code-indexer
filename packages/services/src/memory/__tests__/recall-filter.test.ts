import { describe, it, expect } from 'vitest';
import { parseKeepIds, decideKeep, LlmRecallFilter } from '../recall-filter.js';
import type { RetrievedMemory } from '../retriever.js';
import type { PipelineProviderResolver } from '../../pipelines/index.js';

const item = (id: string): RetrievedMemory => ({ id, title: `t${id}`, content: `c${id}`, importance: 0.5 });

describe('parseKeepIds', () => {
  it('extracts ids from a JSON array (string or number)', () => {
    expect(parseKeepIds('["3","1"]')).toEqual(['3', '1']);
    expect(parseKeepIds('[3, 1]')).toEqual(['3', '1']);
  });
  it('strips fences and surrounding prose', () => {
    expect(parseKeepIds('Keep:\n```json\n["2"]\n```')).toEqual(['2']);
  });
  it('returns [] for an explicit empty array', () => {
    expect(parseKeepIds('[]')).toEqual([]);
  });
  it('returns null when there is no array at all', () => {
    expect(parseKeepIds('none are useful')).toBeNull();
    expect(parseKeepIds('{}')).toBeNull();
  });
  it('leniently recovers an array nested in an object wrapper', () => {
    expect(parseKeepIds('{"keep":["1"]}')).toEqual(['1']);
  });
});

describe('decideKeep', () => {
  const items = [item('1'), item('2'), item('3')];
  it('null (unparseable) keeps all — fail-open', () => {
    expect(decideKeep(items, null)).toEqual(items);
  });
  it('empty array keeps none — model judged none useful (CC)', () => {
    expect(decideKeep(items, [])).toEqual([]);
  });
  it('keeps the matching subset (in items order)', () => {
    expect(decideKeep(items, ['3', '1']).map((m) => m.id)).toEqual(['1', '3']);
  });
  it('ids given but NONE match keeps all — fail-open', () => {
    expect(decideKeep(items, ['99']).map((m) => m.id)).toEqual(['1', '2', '3']);
  });
});

describe('LlmRecallFilter.filter — fail-open', () => {
  const items = [item('1'), item('2')];
  it('returns items unchanged when skipLlm', async () => {
    const f = new LlmRecallFilter({ resolver: {} as PipelineProviderResolver, skipLlm: true });
    expect(await f.filter('task', items)).toEqual(items);
  });
  it('skips the call (and returns) with fewer than two candidates', async () => {
    const resolver = {
      resolveOrNull: async () => { throw new Error('must not be called'); },
    } as unknown as PipelineProviderResolver;
    expect(await new LlmRecallFilter({ resolver }).filter('task', [item('1')])).toEqual([item('1')]);
  });
  it('returns items unchanged when no binding resolves', async () => {
    const resolver = { resolveOrNull: async () => null } as unknown as PipelineProviderResolver;
    expect(await new LlmRecallFilter({ resolver }).filter('task', items)).toEqual(items);
  });
});
