import type DatabaseConstructor from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { SkillStore } from '../skill-store.js';

type DatabaseInstance = InstanceType<typeof DatabaseConstructor>;

interface SummaryRow {
  id: string;
  name: string;
  scope: string;
  enabled: number;
  source: string;
  updated_at: string;
}

function fixture(rows: SummaryRow[], totalCount = rows.length) {
  const prepared: string[] = [];
  const calls: Array<readonly unknown[]> = [];
  const database = {
    prepare: vi.fn((sql: string) => {
      prepared.push(sql);
      if (sql.includes('COUNT(*)')) {
        return {
          get: (...params: unknown[]) => {
            calls.push(params);
            return {
              count: totalCount,
              updated_at: rows.at(-1)?.updated_at ?? null,
            };
          },
        };
      }
      return {
        all: (...params: unknown[]) => {
          calls.push(params);
          const limit = Number(params.at(-2));
          const offset = Number(params.at(-1));
          return rows.slice(offset, offset + limit);
        },
      };
    }),
  } as unknown as DatabaseInstance;
  return { store: new SkillStore(database), prepared, calls };
}

describe('SkillStore.listSkillSummaries', () => {
  it('pages metadata without selecting prompt bodies', () => {
    const rows: SummaryRow[] = [
      { id: 'alpha', name: 'Alpha', scope: 'global', enabled: 1, source: 'builtin', updated_at: '2026-08-01T10:00:00.000Z' },
      { id: 'beta', name: 'Beta', scope: '7', enabled: 1, source: 'user', updated_at: '2026-08-01T11:00:00.000Z' },
    ];
    const firstFixture = fixture(rows);
    const first = firstFixture.store.listSkillSummaries({
      scopes: ['global', '7'],
      enabled: true,
      offset: 0,
      limit: 1,
    });
    const secondFixture = fixture(rows);
    const second = secondFixture.store.listSkillSummaries({
      scopes: ['global', '7'],
      enabled: true,
      offset: first.nextOffset!,
      limit: 1,
    });

    expect(first).toMatchObject({
      totalCount: 2,
      nextOffset: 1,
      items: [{ id: 'alpha', name: 'Alpha', enabled: true }],
    });
    expect(first.items[0]).not.toHaveProperty('prompt_body');
    expect(second).toMatchObject({
      totalCount: 2,
      nextOffset: null,
      items: [{ id: 'beta', name: 'Beta', enabled: true }],
    });
    expect(second.revision).toBe(first.revision);
    expect(firstFixture.prepared.find((sql) => sql.includes('ORDER BY')))
      .not.toContain('prompt_body');
  });

  it('binds the optional id filter and returns a finite empty revision', () => {
    const row: SummaryRow = {
      id: 'disabled',
      name: 'Disabled',
      scope: 'global',
      enabled: 0,
      source: 'user',
      updated_at: '2026-08-01T12:00:00.000Z',
    };
    const filtered = fixture([row]);
    expect(filtered.store.listSkillSummaries({
      scopes: ['global'],
      ids: ['disabled'],
      offset: 0,
      limit: 10,
    }).items.map((item) => item.id)).toEqual(['disabled']);
    expect(filtered.prepared.every((sql) => sql.includes('id IN (?)'))).toBe(true);
    expect(filtered.calls.flat()).toContain('disabled');

    expect(fixture([]).store.listSkillSummaries({
      scopes: [],
      offset: 0,
      limit: 10,
    })).toEqual({ items: [], totalCount: 0, nextOffset: null, revision: 1 });
  });
});
