import { describe, expect, it } from 'vitest';
import { listConsolidationCandidates } from '../memory-consolidation.js';
import type { DB } from '../types.js';

describe('memory consolidation candidate query', () => {
  it('selects only project snapshot/log state and leaves activity to the filesystem catalog', () => {
    let statement = '';
    let allArgs: unknown[] = [];
    const expected = [{ project_id: 7, project_name: 'Seven' }];
    const db = {
      prepare(sql: string) {
        statement = sql;
        return {
          all: (...args: unknown[]) => {
            allArgs = args;
            return expected;
          },
        };
      },
    } as unknown as DB;

    expect(listConsolidationCandidates(db)).toBe(expected);
    expect(allArgs).toEqual([]);
    expect(statement).toMatch(/FROM projects/i);
    expect(statement).toMatch(/FROM snapshots/i);
    expect(statement).toMatch(/FROM memory_distill_log/i);
    expect(statement).not.toMatch(/coder_sessions|session_id/i);
    expect(statement).not.toMatch(/\bLIMIT\b/i);
  });
});
