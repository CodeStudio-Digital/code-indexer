/**
 * The editable data grid sends its changeset to `dbClient.editRows`, which
 * builds the SQL from `schema`/`table` on every change. The grid used to drop
 * both (the hook's `buildChanges` only accepted `(rows, pkCols)` while the tab
 * called it with four arguments), so every apply reached the DML builder with
 * `table: undefined` — inline editing was dead on arrival for all engines.
 *
 * These tests pin the relation on every op plus the no-op/duplicate filtering
 * that keeps an apply from writing more than the user actually changed.
 */
import { describe, expect, it } from 'vitest';
import { buildRowChanges, rowKeyOf, sameValue, type ChangeSetState } from '../build-row-changes.js';

const empty: ChangeSetState = { edited: {}, deleted: new Set(), newRows: [] };
const rows = [
  { id: 1, name: 'ada', score: 10 },
  { id: 2, name: 'linus', score: 20 },
];
const PK = ['id'];

describe('buildRowChanges — relation', () => {
  it('carries schema + table on an update', () => {
    const state: ChangeSetState = { ...empty, edited: { [rowKeyOf(rows[0], PK)]: { name: 'Ada' } } };
    expect(buildRowChanges(state, rows, PK, 'public', 'users')).toEqual([
      { op: 'update', schema: 'public', table: 'users', pk: { id: 1 }, values: { name: 'Ada' } },
    ]);
  });

  it('carries schema + table on a delete', () => {
    const state: ChangeSetState = { ...empty, deleted: new Set([rowKeyOf(rows[1], PK)]) };
    expect(buildRowChanges(state, rows, PK, 'public', 'users')).toEqual([
      { op: 'delete', schema: 'public', table: 'users', pk: { id: 2 } },
    ]);
  });

  it('carries schema + table on an insert', () => {
    const state: ChangeSetState = { ...empty, newRows: [{ tempId: 'new:1', values: { name: 'grace' } }] };
    expect(buildRowChanges(state, rows, PK, 'public', 'users')).toEqual([
      { op: 'insert', schema: 'public', table: 'users', values: { name: 'grace' } },
    ]);
  });

  it('keeps schema undefined (sqlite/mysql) without losing the table', () => {
    const state: ChangeSetState = { ...empty, edited: { [rowKeyOf(rows[0], PK)]: { score: 11 } } };
    const [change] = buildRowChanges(state, rows, PK, undefined, 'users');
    expect(change.schema).toBeUndefined();
    expect(change.table).toBe('users');
  });

  it('scopes a composite primary key with every key column', () => {
    const composite = [{ tenant: 'a', id: 1, note: 'x' }];
    const state: ChangeSetState = { ...empty, edited: { [rowKeyOf(composite[0], ['tenant', 'id'])]: { note: 'y' } } };
    expect(buildRowChanges(state, composite, ['tenant', 'id'], undefined, 'notes')[0].pk)
      .toEqual({ tenant: 'a', id: 1 });
  });
});

describe('buildRowChanges — what it refuses to send', () => {
  it('drops a column typed back to its stored value', () => {
    const state: ChangeSetState = { ...empty, edited: { [rowKeyOf(rows[0], PK)]: { name: 'ada', score: 99 } } };
    expect(buildRowChanges(state, rows, PK, undefined, 'users')).toEqual([
      { op: 'update', schema: undefined, table: 'users', pk: { id: 1 }, values: { score: 99 } },
    ]);
  });

  it('emits nothing when every edited column matches the stored row', () => {
    const state: ChangeSetState = { ...empty, edited: { [rowKeyOf(rows[0], PK)]: { name: 'ada' } } };
    expect(buildRowChanges(state, rows, PK, undefined, 'users')).toEqual([]);
  });

  it('delete wins over a pending edit on the same row', () => {
    const key = rowKeyOf(rows[0], PK);
    const state: ChangeSetState = { ...empty, edited: { [key]: { name: 'Ada' } }, deleted: new Set([key]) };
    expect(buildRowChanges(state, rows, PK, undefined, 'users')).toEqual([
      { op: 'delete', schema: undefined, table: 'users', pk: { id: 1 } },
    ]);
  });

  it('applies a duplicated row key once (non-unique projection)', () => {
    const dupes = [{ id: 1, name: 'ada' }, { id: 1, name: 'ada' }];
    const state: ChangeSetState = { ...empty, edited: { [rowKeyOf(dupes[0], PK)]: { name: 'Ada' } } };
    expect(buildRowChanges(state, dupes, PK, undefined, 'users')).toHaveLength(1);
  });

  it('skips a new row the user never filled in', () => {
    const state: ChangeSetState = {
      ...empty,
      newRows: [{ tempId: 'new:1', values: {} }, { tempId: 'new:2', values: { name: 'grace' } }],
    };
    expect(buildRowChanges(state, [], PK, undefined, 'users')).toHaveLength(1);
  });

  it('keeps an explicit NULL on a new row but drops undefined cells', () => {
    const state: ChangeSetState = { ...empty, newRows: [{ tempId: 'new:1', values: { name: null, score: undefined } }] };
    expect(buildRowChanges(state, [], PK, undefined, 'users')[0].values).toEqual({ name: null });
  });
});

describe('sameValue', () => {
  it('compares dates by instant, not identity', () => {
    expect(sameValue(new Date('2026-07-25T10:00:00Z'), new Date('2026-07-25T10:00:00Z'))).toBe(true);
    expect(sameValue(new Date('2026-07-25T10:00:00Z'), new Date('2026-07-26T10:00:00Z'))).toBe(false);
  });

  it('compares JSON column values structurally', () => {
    expect(sameValue({ a: 1 }, { a: 1 })).toBe(true);
    expect(sameValue({ a: 1 }, { a: 2 })).toBe(false);
  });

  it('does not conflate null with a numeric zero', () => {
    expect(sameValue(null, 0)).toBe(false);
    expect(sameValue(null, null)).toBe(true);
  });
});
