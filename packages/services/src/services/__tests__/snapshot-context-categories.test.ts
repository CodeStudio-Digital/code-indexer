import { describe, expect, it } from 'vitest';
import type { ContextSnapshot } from '@mcp/shared/types.js';
import { SnapshotService } from '../snapshots.js';

describe('preserved context category rendering', () => {
  it('keeps gotchas, procedures, user feedback and future categories', () => {
    const categories = ['architecture', 'decision', 'pattern', 'convention', 'todo', 'note', 'gotcha', 'procedure', 'user', 'feedback', 'future'];
    const rows = categories.map(category => ({ category, title: `title-${category}`, content: `body-${category}` })) as ContextSnapshot[];
    const context = SnapshotService.renderGrouped(rows);
    for (const category of categories) expect(context).toContain(`body-${category}`);
    expect(SnapshotService.renderGrouped([])).toBe('');
  });
});
