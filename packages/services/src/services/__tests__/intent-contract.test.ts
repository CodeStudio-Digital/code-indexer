import { describe, it, expect } from 'vitest';
import {
  IntentContractCompiler,
  parseObligations,
  formatContractSection,
  type IntentContractCache,
} from '../intent-contract.js';
import type { PipelineProviderResolver } from '../../pipelines/index.js';

describe('parseObligations', () => {
  it('parses well-formed obligations and fills defaults', () => {
    const raw = JSON.stringify({
      obligations: [
        { id: 'OB1', kind: 'behavior', text: 'return 404 when snapshot is missing', evidenceHint: 'routes/snapshot.ts', mustHave: true },
        { kind: 'weird-kind', text: 'update docs', mustHave: 'yes' },
      ],
    });
    const obs = parseObligations(raw);
    expect(obs).toHaveLength(2);
    expect(obs[0]).toMatchObject({ id: 'OB1', kind: 'behavior', mustHave: true });
    // Unknown kind → behavior; non-boolean mustHave → false; missing id → generated.
    expect(obs[1]).toMatchObject({ id: 'OB2', kind: 'behavior', mustHave: false, evidenceHint: null });
  });

  it('drops entries without text and tolerates fenced JSON', () => {
    const raw = '```json\n{"obligations":[{"id":"OB1"},{"id":"OB2","text":"real one"}]}\n```';
    const obs = parseObligations(raw);
    expect(obs).toHaveLength(1);
    expect(obs[0].text).toBe('real one');
  });
});

describe('IntentContractCompiler', () => {
  const resolveContext = { sessionId: 1 };

  it('serves from the cache without resolving a model', async () => {
    let resolved = false;
    const resolver = {
      resolveChain: async () => {
        resolved = true;
        return [];
      },
    } as unknown as PipelineProviderResolver;
    const cache: IntentContractCache = {
      getContract: () =>
        JSON.stringify({ obligations: [{ id: 'OB1', kind: 'test', text: 'cached', mustHave: true }] }),
      saveContract: () => {},
    };
    const compiler = new IntentContractCompiler(resolver, cache);
    const obs = await compiler.compile({
      sessionKind: 'coder',
      sessionId: 1,
      resolveContext,
      intentSource: 'Fix the bug',
    });
    expect(obs).toHaveLength(1);
    expect(obs![0].text).toBe('cached');
    expect(resolved).toBe(false);
  });

  it('returns null when unconfigured (empty chain) or intent is blank', async () => {
    const resolver = { resolveChain: async () => [] } as unknown as PipelineProviderResolver;
    const compiler = new IntentContractCompiler(resolver);
    await expect(
      compiler.compile({ sessionKind: 'coder', sessionId: 1, resolveContext, intentSource: 'x' }),
    ).resolves.toBeNull();
    await expect(
      compiler.compile({ sessionKind: 'coder', sessionId: 1, resolveContext, intentSource: '   ' }),
    ).resolves.toBeNull();
  });
});

describe('formatContractSection', () => {
  it('renders id, kind, must-have flag and evidence hint', () => {
    const text = formatContractSection([
      { id: 'OB1', kind: 'migration', text: 'add forward migration', evidenceHint: 'migrations/', mustHave: true },
      { id: 'OB2', kind: 'behavior', text: 'nice to have', evidenceHint: null, mustHave: false },
    ])!;
    expect(text).toContain('OB1 [migration] (must-have) add forward migration — evidence hint: migrations/');
    expect(text).toContain('OB2 [behavior] nice to have');
    expect(text).not.toContain('OB2 [behavior] (must-have)');
  });

  it('returns null for an empty contract', () => {
    expect(formatContractSection([])).toBeNull();
  });
});
