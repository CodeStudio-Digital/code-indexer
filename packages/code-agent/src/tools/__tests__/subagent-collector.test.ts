/** Frente C — the collector's data model: memo bounds, snapshot isolation, board post ids and per-run caps. */
import { describe, it, expect } from 'vitest';
import { recordMemoTool } from '../record-memo.js';
import { SubagentCollector } from '@mcp/code-agent/tools/subagent-collector.js';

const BOARD_POST_ID = '00000000-0000-4000-8000-000000000042';

it('bounds each memo and isolates returned snapshots from later caller mutation', async () => {
  const collector = new SubagentCollector();
  expect(collector.recordMemo('x'.repeat(301))).toBe(false);
  expect(collector.recordMemo('x'.repeat(300))).toBe(true);
  const snapshot = collector.snapshot(); snapshot.memos[0].text = 'changed outside';
  expect(collector.snapshot().memos[0].text).toHaveLength(300);
  const result = await recordMemoTool.handler({ text: 'y'.repeat(301) }, { cwd: '.', projectName: 'test', subagentCollector: collector });
  expect(result.isError).toBe(true); expect(collector.snapshot().memos).toHaveLength(1);
});

describe('subagent-collector', () => {
  it('has no content when nothing was recorded', () => {
    expect(new SubagentCollector().hasContent()).toBe(false);
  });

  it('normalizes board post UUIDs and rejects legacy numeric ids', () => {
    const c = new SubagentCollector();
    c.recordBoardPost('handoff', 'pass to frontend', BOARD_POST_ID.toUpperCase());
    expect(c.snapshot().boardPosts[0].id).toBe(BOARD_POST_ID);

    expect(() => c.recordBoardPost(
      'handoff',
      'legacy post',
      42 as unknown as string,
    )).toThrow(/canonical UUID/);
    expect(() => c.recordBoardPost('handoff', 'malformed post', '42')).toThrow(/canonical UUID/);
    expect(c.snapshot().boardPosts).toHaveLength(1);
  });

  it('drops entries past the per-run caps without throwing', () => {
    const c = new SubagentCollector();
    // The default MEMO cap is 50; pumping 60 should yield exactly 50.
    for (let i = 0; i < 60; i++) c.recordMemo(`memo ${i}`);
    expect(c.snapshot().memos.length).toBe(50);
  });

  it('truncates snapshot/board previews to ~200 chars', () => {
    const c = new SubagentCollector();
    const longBody = 'x'.repeat(500);
    c.recordSnapshot('s1', 'general', longBody);
    c.recordBoardPost('deliverable', longBody);
    expect(c.snapshot().snapshots[0].preview.length).toBeLessThanOrEqual(200);
    expect(c.snapshot().boardPosts[0].preview.length).toBeLessThanOrEqual(200);
  });
});
