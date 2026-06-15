/**
 * renderPreflightHint — pure renderer of the `<preflight>` block.
 * Pinned exactly: the block is hashed for injection dedup, so any change
 * here is intentional (it forces a re-inject on resumed runners).
 */
import { describe, expect, it } from 'vitest';
import { renderPreflightHint } from '../preflight-hint.js';

describe('renderPreflightHint', () => {
  it('renders the full block deterministically', () => {
    const hint = renderPreflightHint({
      profile: 'navigate',
      taskKind: 'bugfix',
      pinTools: ['read_file', 'edit_file'],
      memories: [
        { title: 'Auth token refresh gotcha', reason: 'same login flow' },
        { title: 'API error envelope', reason: '' },
      ],
    });
    expect(hint).toBe([
      '<preflight>',
      'task_kind: bugfix',
      'toolset seeded for this task: profile=navigate; prioritized: read_file, edit_file',
      'read these project memories BEFORE exploring (recall_memory({query:"<title>"})):',
      '- "Auth token refresh gotcha" — same login flow',
      '- "API error envelope"',
      'note: these are suggestions from a cheap pre-analysis. Verify against the code; find_tools / expand_toolset remain available if something is missing.',
      '</preflight>',
    ].join('\n'));
  });

  it('memories-only seed omits the toolset and task_kind lines', () => {
    const hint = renderPreflightHint({ memories: [{ title: 'X', reason: 'y' }] });
    expect(hint).not.toContain('toolset seeded');
    expect(hint).not.toContain('task_kind');
    expect(hint).toContain('- "X" — y');
  });

  it('tools-only seed omits the memories block', () => {
    const hint = renderPreflightHint({ profile: 'bootstrap', pinTools: ['read_file'] });
    expect(hint).toContain('profile=bootstrap');
    expect(hint).not.toContain('recall_memory');
  });
});
