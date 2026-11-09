import { describe, it, expect } from 'vitest';
import { overlayLiveState, renderSummaryV2, type CompactionSummaryV2 } from '@mcp/code-agent/core/summarizer.js';

const baseSummary: CompactionSummaryV2 = {
  primary_request: 'fix login',
  key_concepts: [],
  files_and_code: [],
  errors_and_fixes: [],
  problem_solving: '',
  all_user_messages: [],
  pending_tasks: ['(stale) Refactor parser', '(stale) Add tests'],
  current_work: '',
  next_step: '',
};

describe('overlayLiveState', () => {
  it('replaces pending_tasks with live unfinished todos', () => {
    const out = overlayLiveState(
      baseSummary,
      [
        { content: 'New task A', activeForm: 'Doing A', status: 'in_progress' },
        { content: 'New task B', activeForm: 'Doing B', status: 'pending' },
        { content: 'Done task', activeForm: 'Doing done', status: 'completed' },
      ],
    );
    expect(out.pending_tasks).toEqual([
      '[in_progress] New task A',
      '[pending] New task B',
    ]);
  });

  it('keeps stale pending_tasks if there are no unfinished live todos', () => {
    const out = overlayLiveState(
      baseSummary,
      [{ content: 'Done', activeForm: 'Doing done', status: 'completed' }],
    );
    expect(out.pending_tasks).toEqual(baseSummary.pending_tasks);
  });
});
