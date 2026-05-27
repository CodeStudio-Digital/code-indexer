/**
 * Unit tests for `renderSummaryAsMessage`. The text body is produced by
 * `renderSummaryV2` (which has its own coverage in `core/summarizer.ts`'s
 * sibling tests if any); these tests only assert the wire wrapping.
 */
import { describe, it, expect } from 'vitest';
import { renderSummaryAsMessage } from '../summary-renderer.js';
import type { CompactionSummaryV2 } from '@mcp/code-agent/core/summarizer.js';

const SUMMARY: CompactionSummaryV2 = {
  primary_request: 'build the thing',
  key_concepts: ['react', 'sqlite'],
  files_and_code: [{ path: 'src/app.ts', state: 'created' }],
  errors_and_fixes: ['fixed off-by-one'],
  problem_solving: 'tried A, switched to B',
  all_user_messages: ['m1', 'm2'],
  pending_tasks: ['ship'],
  current_work: 'writing tests',
  next_step: 'commit',
};

describe('renderSummaryAsMessage', () => {
  it('wraps the rendered text into a single-text-block user message', () => {
    const msg = renderSummaryAsMessage(SUMMARY);
    expect(msg.role).toBe('user');
    expect(msg.content).toHaveLength(1);
    expect(msg.content[0]).toMatchObject({ type: 'text' });
  });

  it('includes the auto-compacted prefix tag from renderSummaryV2', () => {
    const msg = renderSummaryAsMessage(SUMMARY);
    const text = (msg.content[0] as { type: 'text'; text: string }).text;
    expect(text).toMatch(/auto-compacted summary/i);
  });

  it('surfaces the primary_request and current_focus from the input summary', () => {
    const msg = renderSummaryAsMessage(SUMMARY);
    const text = (msg.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('build the thing');
    expect(text).toContain('writing tests');
    expect(text).toContain('commit');
  });

  it('emits empty content when every section is blank', () => {
    const empty: CompactionSummaryV2 = {
      primary_request: '',
      key_concepts: [],
      files_and_code: [],
      errors_and_fixes: [],
      problem_solving: '',
      all_user_messages: [],
      pending_tasks: [],
      current_work: '',
      next_step: '',
    };
    const msg = renderSummaryAsMessage(empty);
    const text = (msg.content[0] as { type: 'text'; text: string }).text;
    // The header still appears; nothing else.
    expect(text).toMatch(/auto-compacted summary/i);
    expect(text).not.toContain('<primary_request>');
  });
});
