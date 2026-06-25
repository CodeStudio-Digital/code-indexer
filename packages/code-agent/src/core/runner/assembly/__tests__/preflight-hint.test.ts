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
      suggestedSkills: [{ id: 'api-collection', reason: 'build the HTTP client' }],
      memories: [
        { title: 'Auth token refresh gotcha', reason: 'same login flow' },
        { title: 'API error envelope', reason: '' },
      ],
    });
    expect(hint).toBe([
      '<preflight>',
      'task_kind: bugfix',
      'toolset seeded for this task: profile=navigate; prioritized: read_file, edit_file',
      'skills that may fit this task — load the body BEFORE starting (get_skill_content({skill_id:"<id>"})):',
      '- api-collection — build the HTTP client',
      'read these project memories BEFORE exploring (recall_memory({query:"<title>"})):',
      '- "Auth token refresh gotcha" — same login flow',
      '- "API error envelope"',
      'note: these are suggestions from a cheap pre-analysis run before any code was read. Verify against the code; if a memory conflicts with what you observe, trust the code (memories age when files change); find_tools / expand_toolset remain available if something is missing.',
      '</preflight>',
    ].join('\n'));
  });

  it('memories-only seed omits the toolset and task_kind lines', () => {
    const hint = renderPreflightHint({ memories: [{ title: 'X', reason: 'y' }] });
    expect(hint).not.toContain('toolset seeded');
    expect(hint).not.toContain('task_kind');
    expect(hint).toContain('- "X" — y');
  });

  it('skills-only seed renders the skills nudge and omits memories', () => {
    const hint = renderPreflightHint({ suggestedSkills: [{ id: 'qa-playwright', reason: '' }] });
    expect(hint).toContain('get_skill_content({skill_id:"<id>"})');
    expect(hint).toContain('- qa-playwright');
    expect(hint).not.toContain('recall_memory');
  });

  it('tools-only seed omits the memories and skills blocks', () => {
    const hint = renderPreflightHint({ profile: 'bootstrap', pinTools: ['read_file'] });
    expect(hint).toContain('profile=bootstrap');
    expect(hint).not.toContain('recall_memory');
    expect(hint).not.toContain('get_skill_content');
  });
});
