import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { ChatProvider } from '../../providers/adapter.js';
import type { ToolContext } from '../../core/tool.js';
import type { FsSessionStore } from '../../sessions/fs-store/index.js';
import { asSessionId } from '@mcp/session-storage';

const runReviewSubagent = vi.hoisted(() => vi.fn());

vi.mock('@mcp/code-agent/tools/review-subagent.js', () => ({
  runReviewSubagent,
}));

import { buildRequestReviewTool } from '../request-review.js';

describe('request_review filesystem session integration', () => {
  it('uses the configured review resolver and does not mark inconclusive reviews complete', async () => {
    const parent = {} as ChatProvider, configured = {} as ChatProvider, resolveReviewerProvider = vi.fn(async () => configured);
    const markSessionReviewedNow = vi.fn(async () => undefined);
    runReviewSubagent.mockResolvedValue({ findings: [], parsed: false, raw: 'interrupted', usage: { input_tokens: 2, output_tokens: 1 } });
    const tool = buildRequestReviewTool({ provider: parent, parentTools: [], resolveReviewerProvider,
      sessionId: asSessionId('11111111-1111-4111-8111-111111111111'), sessionStore: { markSessionReviewedNow } as unknown as FsSessionStore });
    const result = await tool.handler({ spec: 'Review', diff: 'diff --git a/a b/a' }, {} as ToolContext);
    expect(result.isError).toBe(true); expect(result.structuredData).toMatchObject({ status: 'inconclusive' });
    expect(markSessionReviewedNow).not.toHaveBeenCalled(); expect(resolveReviewerProvider).toHaveBeenCalledOnce();
    expect(runReviewSubagent.mock.calls.at(-1)?.[0].provider).toBe(configured);
  });

  it('does not invoke the reviewer or write a marker after cancellation during provider resolution', async () => {
    const ctrl = new AbortController(), calls = runReviewSubagent.mock.calls.length, markSessionReviewedNow = vi.fn(async () => undefined);
    const tool = buildRequestReviewTool({ provider: {} as ChatProvider, parentTools: [],
      resolveReviewerProvider: async () => { ctrl.abort(new Error('cancel review')); return {} as ChatProvider; },
      sessionStore: { markSessionReviewedNow } as unknown as FsSessionStore });
    const result = await tool.handler({ spec: 'Review', diff: 'diff --git a/a b/a' }, { signal: ctrl.signal } as ToolContext);
    expect(result.isError).toBe(true); expect(runReviewSubagent).toHaveBeenCalledTimes(calls); expect(markSessionReviewedNow).not.toHaveBeenCalled();
  });
  it('awaits the durable reviewed marker before completing the tool call', async () => {
    let releaseMarker!: () => void;
    const markerCommitted = new Promise<void>((resolve) => {
      releaseMarker = resolve;
    });
    const markSessionReviewedNow = vi.fn(() => markerCommitted);
    runReviewSubagent.mockResolvedValue({
      findings: [],
      parsed: true,
      raw: '<review>{"findings":[]}</review>',
      usage: {
        input_tokens: 11,
        output_tokens: 3,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    });

    const sessionId = asSessionId('11111111-1111-4111-8111-111111111111');
    const tool = buildRequestReviewTool({
      provider: {} as ChatProvider,
      parentTools: [],
      sessionId,
      sessionStore: { markSessionReviewedNow } as unknown as FsSessionStore,
    });

    let settled = false;
    const resultPromise = tool.handler(
      { spec: 'Review the UUID migration', diff: 'diff --git a/a b/a' },
      {} as ToolContext,
    ).then((result) => {
      settled = true;
      return result;
    });

    await vi.waitFor(() => {
      expect(markSessionReviewedNow).toHaveBeenCalledWith(sessionId);
    });
    expect(settled).toBe(false);

    releaseMarker();
    const result = await resultPromise;
    expect(result.content).toContain('Reviewer found no issues');
  });

  it('gives the reviewer the parent tool set resolved at review time, not at registration', async () => {
    runReviewSubagent.mockResolvedValue({ findings: [], parsed: true, raw: '<review>{"findings":[]}</review>',
      usage: { input_tokens: 1, output_tokens: 1 } });
    const fixture = (name: string) => ({ name, description: name, source: 'native', parameters: { type: 'object', properties: {} },
      handler: async () => ({ content: '' }) }) as never;
    let snapshot: never[] = [fixture('read_file'), fixture('git_diff')];
    const tool = buildRequestReviewTool({ provider: {} as ChatProvider, parentTools: () => snapshot });
    // Filters applied after registration (allowlist, research preset, disabled lists).
    snapshot = [fixture('read_file')];
    await tool.handler({ spec: 'Review', diff: 'diff --git a/a b/a' }, {} as ToolContext);
    expect((runReviewSubagent.mock.calls.at(-1)?.[0].tools as Array<{ name: string }>).map(t => t.name)).toEqual(['read_file']);
  });

  it('index.ts hands request_review the same tool snapshot the subagents get', () => {
    const src = readFileSync(fileURLToPath(new URL('../../index.ts', import.meta.url)), 'utf8');
    expect(src).toContain('parentTools: () => childToolSnapshot,');
    const assigned = src.indexOf('childToolSnapshot = ');
    expect(assigned).toBeGreaterThan(src.indexOf('pruneRedundantPrimaryTwins(registry'));
    expect(src.indexOf('const parentTools = childToolSnapshot;')).toBeGreaterThan(assigned);
  });
});
