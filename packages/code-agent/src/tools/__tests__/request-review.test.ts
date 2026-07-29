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
});
