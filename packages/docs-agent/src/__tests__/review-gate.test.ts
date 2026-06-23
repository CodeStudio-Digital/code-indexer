/**
 * Coverage for the fidelity review gate.
 *
 * reviewAnswer: verifies an answer against cited chunks via the strong
 * binding; degrades to verdict='pass', ran=false on any failure.
 * applyReview: folds a verdict in — repaired markdown + downgraded
 * confidence + transparent caveat on 'repair', no-op on 'pass'.
 *
 * The reviewer LLM is mocked by stubbing global fetch (same pattern as the
 * reranker test) — these tests are about the gate's logic, not the model.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { reviewAnswer, applyReview, type ReviewResult } from '../review/review-gate.js';
import type { ResolvedBinding } from '@mcp/services/pipelines/index.js';

function makeBinding(): ResolvedBinding {
  return {
    pipelineName: 'docs_research',
    bindingRole: 'scorer_llm',
    provider: { id: 'p1', kind: 'cloudflare', enabled: true } as unknown as ResolvedBinding['provider'],
    modelId: 'fake-reviewer',
    modelMode: '',
    config: {},
    resolvedFrom: 'global',
    bindingId: 1,
  };
}

function stubFetchOk(content: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
}

const chunks = [{ chunk_id: 1, heading_path: 'Guide > A', content: 'Alpha does X.' }];

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe('reviewAnswer', () => {
  it('passes when the reviewer finds everything supported', async () => {
    stubFetchOk('{"verdict":"pass","unsupportedClaims":[],"uncoveredSubQuestions":[]}');
    const r = await reviewAnswer({ query: 'q', markdown: 'X is supported [^1]', chunks, binding: makeBinding() });
    expect(r.ran).toBe(true);
    expect(r.verdict).toBe('pass');
  });

  it('repairs when the reviewer flags unsupported claims', async () => {
    stubFetchOk('{"verdict":"repair","unsupportedClaims":["Y is unsupported"],"uncoveredSubQuestions":[],"repairedMarkdown":"X only [^1]"}');
    const r = await reviewAnswer({ query: 'q', markdown: 'X and Y [^1]', chunks, binding: makeBinding() });
    expect(r.verdict).toBe('repair');
    expect(r.repairedMarkdown).toBe('X only [^1]');
    expect(r.unsupportedClaims).toEqual(['Y is unsupported']);
  });

  it('degrades to pass (ran=false) on unparseable reviewer output', async () => {
    stubFetchOk('the answer looks fine to me');
    const r = await reviewAnswer({ query: 'q', markdown: 'X [^1]', chunks, binding: makeBinding() });
    expect(r.ran).toBe(false);
    expect(r.verdict).toBe('pass');
  });

  it('does not call the reviewer when there are no cited chunks', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const r = await reviewAnswer({ query: 'q', markdown: 'X', chunks: [], binding: makeBinding() });
    expect(r.ran).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('applyReview', () => {
  it('is a no-op on a pass verdict', () => {
    const review: ReviewResult = { verdict: 'pass', unsupportedClaims: [], uncoveredSubQuestions: [], ran: true };
    const out = applyReview('answer', 'high', review);
    expect(out.markdown).toBe('answer');
    expect(out.confidence).toBe('high');
    expect(out.reviewNote).toBeNull();
  });

  it('is a no-op when the gate did not run', () => {
    const review: ReviewResult = { verdict: 'repair', unsupportedClaims: ['z'], uncoveredSubQuestions: [], ran: false };
    const out = applyReview('answer', 'high', review);
    expect(out.markdown).toBe('answer');
    expect(out.confidence).toBe('high');
  });

  it('swaps repaired markdown, downgrades confidence, and appends a caveat', () => {
    const review: ReviewResult = {
      verdict: 'repair',
      repairedMarkdown: 'fixed answer',
      unsupportedClaims: ['z'],
      uncoveredSubQuestions: [],
      ran: true,
    };
    const out = applyReview('original answer', 'high', review);
    expect(out.markdown).toContain('fixed answer');
    expect(out.markdown).toContain('Fidelity review');
    expect(out.confidence).toBe('medium');
    expect(out.reviewNote).not.toBeNull();
  });

  it('downgrades medium→low and floors low at low', () => {
    const review: ReviewResult = {
      verdict: 'repair',
      repairedMarkdown: 'x',
      unsupportedClaims: ['z'],
      uncoveredSubQuestions: [],
      ran: true,
    };
    expect(applyReview('m', 'medium', review).confidence).toBe('low');
    expect(applyReview('m', 'low', review).confidence).toBe('low');
  });
});
