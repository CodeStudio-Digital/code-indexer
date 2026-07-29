/**
 * Frente C — collector data model and parent-side renderer.
 *
 * Locks in:
 *   - the renderer produces an empty string when nothing was collected
 *     (so the parent's `header + body + trail` concat is a true no-op),
 *   - memos / snapshots / board posts each render under their own H3,
 *   - per-channel ordering is preserved (insertion order),
 *   - the snapshot returned by `SubagentCollector.snapshot()` and the
 *     same data passed to `renderCollectedSnapshotForParent` produce
 *     byte-identical output — i.e. parent code that only sees the
 *     plain data has the same view as a renderer with the live collector.
 */
import { describe, it, expect } from 'vitest';
import {
  SubagentCollector,
  renderCollectedSnapshotForParent,
} from '@mcp/code-agent/tools/subagent-collector.js';

const BOARD_POST_ID = '00000000-0000-4000-8000-000000000042';

describe('subagent-collector renderer', () => {
  it('renders empty string when no entries', () => {
    const c = new SubagentCollector();
    expect(c.hasContent()).toBe(false);
    expect(c.renderForParent()).toBe('');
    expect(renderCollectedSnapshotForParent(c.snapshot())).toBe('');
  });

  it('renders memos, snapshots, and board posts under section headers', () => {
    const c = new SubagentCollector();
    c.recordMemo('found stale TODO in foo.ts', 'observation');
    c.recordMemo('chose async path over sync', 'decision');
    c.recordSnapshot('snap-1', 'architecture', 'Notes about the orchestrator design.');
    c.recordBoardPost('deliverable', 'Implemented frente C — collector flow.');

    const out = c.renderForParent();
    expect(out).toContain('## Subagent collected:');
    expect(out).toContain('### Memos');
    expect(out).toContain('[observation] found stale TODO in foo.ts');
    expect(out).toContain('[decision] chose async path over sync');
    expect(out).toContain('### Snapshots');
    expect(out).toContain('architecture (id=snap-1)');
    expect(out).toContain('### Board posts');
    expect(out).toContain('deliverable');
    expect(out).toContain('Implemented frente C');
  });

  it('snapshot() data passed to standalone renderer matches the method output', () => {
    const c = new SubagentCollector();
    c.recordMemo('hello', 'progress');
    c.recordSnapshot('s1', 'pattern', 'short body');
    c.recordBoardPost('handoff', 'pass to frontend', BOARD_POST_ID);
    expect(renderCollectedSnapshotForParent(c.snapshot())).toBe(c.renderForParent());
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
