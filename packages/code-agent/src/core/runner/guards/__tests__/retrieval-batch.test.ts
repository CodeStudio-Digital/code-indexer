import { describe, expect, it } from 'vitest';

import {
  planRetrievalBatch,
  taskQueryOverlap,
  type RetrievalToolUse,
} from '../retrieval-batch.js';

function use(
  id: string,
  name: string,
  input: Record<string, unknown> = {},
): RetrievalToolUse {
  return { id, name, input };
}

describe('planRetrievalBatch', () => {
  it('defers broad project maps when targeted semantic search is in the same batch', () => {
    const plan = planRetrievalBatch([
      use('map', 'mcp__get_repo_map'),
      use('search', 'mcp__search', { query: 'session expiry' }),
    ]);

    expect(plan.get('map')).toMatchObject({
      action: 'coalesce',
      originToolUseId: 'search',
      reason: 'targeted-search-over-broad-map',
    });
    expect(plan.get('search')).toEqual({
      action: 'execute',
      input: { query: 'session expiry' },
    });
  });

  it('keeps complementary sibling searches even when lexical overlap differs', () => {
    const plan = planRetrievalBatch(
      [
        use('aligned', 'mcp__search', { query: 'login lockout attempts' }),
        use('irrelevant', 'mcp__search', { query: 'invoice rounding' }),
        use('also-aligned', 'mcp__search', { query: 'login policy' }),
      ],
      { taskText: 'Planeje a política de login e bloqueio de tentativas.' },
    );

    expect(plan.get('irrelevant')?.action).toBe('execute');
    expect(plan.get('also-aligned')?.action).toBe('execute');
  });

  it('points broad reads at the task-aligned search even when it is not first', () => {
    const plan = planRetrievalBatch(
      [
        use('irrelevant', 'mcp__search', { query: 'invoice rounding' }),
        use('map', 'mcp__get_project_overview'),
        use('aligned', 'mcp__search', { query: 'login lockout' }),
      ],
      { taskText: 'Investigue o bloqueio de login.' },
    );

    expect(plan.get('map')).toMatchObject({ originToolUseId: 'aligned' });
    expect(plan.get('irrelevant')?.action).toBe('execute');
  });

  it('merges compatible regex greps without merging literal or differently filtered calls', () => {
    const plan = planRetrievalBatch([
      use('first', 'mcp__grep_code', { pattern: 'sessionTtl', glob: 'src/**/*.js', max_results: 10 }),
      use('second', 'mcp__grep_code', { pattern: 'expiresAt', glob: 'src/**/*.js', max_results: 30 }),
      use('literal', 'mcp__grep_code', { pattern: '>=', glob: 'src/**/*.js', literal: true }),
      use('test', 'mcp__grep_code', { pattern: 'expiry', glob: 'test/**/*.js' }),
    ]);

    expect(plan.get('first')).toEqual({
      action: 'execute',
      input: {
        pattern: '(?:sessionTtl)|(?:expiresAt)',
        glob: 'src/**/*.js',
        max_results: 40,
      },
    });
    expect(plan.get('second')).toMatchObject({
      action: 'coalesce',
      originToolUseId: 'first',
      reason: 'same-batch-grep-merge',
    });
    expect(plan.get('literal')?.action).toBe('execute');
    expect(plan.get('test')?.action).toBe('execute');
  });

  it('does not merge regexes whose group semantics could change', () => {
    const plan = planRetrievalBatch([
      use('backref', 'mcp__grep_code', { pattern: '(session)\\1' }),
      use('named', 'mcp__grep_code', { pattern: '(?<field>expiresAt)' }),
      use('plain', 'mcp__grep_code', { pattern: 'sessionTtl' }),
    ]);

    expect(plan.get('backref')?.action).toBe('execute');
    expect(plan.get('named')?.action).toBe('execute');
    expect(plan.get('plain')?.action).toBe('execute');
  });

  it('is a no-op behind the kill switch', () => {
    const input = { pattern: 'one' };
    const plan = planRetrievalBatch([
      use('one', 'mcp__grep_code', input),
      use('two', 'mcp__grep_code', { pattern: 'two' }),
    ], { enabled: false });

    expect(plan.get('one')).toEqual({ action: 'execute', input });
    expect(plan.get('two')?.action).toBe('execute');
  });
});

describe('taskQueryOverlap', () => {
  it('normalizes Portuguese accents deterministically', () => {
    expect(taskQueryOverlap(
      'Onde a expiração de sessão é definida?',
      'expiracao sessao token',
    )).toBe(2);
  });
});
