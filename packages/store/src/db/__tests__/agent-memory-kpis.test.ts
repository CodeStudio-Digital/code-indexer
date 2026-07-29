import { describe, expect, it } from 'vitest';
import {
  getMemoryEffectivenessKpis,
  type SessionMemoryKpis,
} from '../agent-memory-kpis.js';
import type { DB } from '../types.js';

describe('Agent Memory KPI source split', () => {
  it('combines bundle counters with only shared Agent Memory SQLite queries', () => {
    const statements: string[] = [];
    const db = {
      prepare(sql: string) {
        statements.push(sql);
        return {
          get: () => {
            if (sql.includes('agent_memory_events')) {
              return { recalls: 4, hits: 3 };
            }
            if (sql.includes("type = 'preference'")) return { c: 5 };
            if (sql.includes('FROM agent_memory')) {
              return { live: 8, accessed: 2 };
            }
            throw new Error(`unexpected SQL: ${sql}`);
          },
        };
      },
    } as unknown as DB;
    const session: SessionMemoryKpis = {
      windowDays: 30,
      sessionsInWindow: 4,
      learnedSessions: 3,
      explicitCalls: {
        recall_memory: 2,
        remember: 1,
      },
    };

    expect(getMemoryEffectivenessKpis(db, 7, session)).toEqual({
      windowDays: 30,
      learningRate: 0.75,
      sessionsInWindow: 4,
      recallHitRate: 0.75,
      recallsInWindow: 4,
      usageCoverage: 0.25,
      liveStock: 8,
      goldStock: 5,
      explicitCalls: {
        recall_memory: 2,
        remember: 1,
      },
    });

    const sql = statements.join('\n');
    expect(sql).not.toMatch(
      /coder_sessions|coder_messages|coder_tool_calls|memory_distill_log/i,
    );
  });

  it('normalizes malformed bundle counters without querying session tables', () => {
    const db = {
      prepare: () => ({
        get: () => {
          throw new Error('shared table unavailable');
        },
      }),
    } as unknown as DB;

    expect(getMemoryEffectivenessKpis(db, 7, {
      windowDays: 0,
      sessionsInWindow: 2,
      learnedSessions: 99,
      explicitCalls: {
        remember: 1.9,
        forget_memory: -1,
      },
    })).toMatchObject({
      windowDays: 1,
      sessionsInWindow: 2,
      learningRate: 1,
      explicitCalls: { remember: 1 },
    });
  });
});
