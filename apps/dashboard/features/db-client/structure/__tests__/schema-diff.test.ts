import { describe, expect, it } from 'vitest';
import { diffSchemas } from '../schema-diff.js';
import type { DbSchemaSnapshot } from '../../types.js';

function snapshot(schema: string, tables: DbSchemaSnapshot['tables']): DbSchemaSnapshot {
  return { schema, tables, capturedAt: 1 };
}

describe('schema diff', () => {
  it('creates missing tables and flags destructive removals', () => {
    const source = snapshot('public', [{ schema: 'public', name: 'users', columns: [{ name: 'id', dataType: 'integer', nullable: false, isPrimaryKey: true }] }]);
    const target = snapshot('dbo', [{ schema: 'dbo', name: 'legacy', columns: [] }]);
    const changes = diffSchemas(source, target);
    expect(changes.find((change) => change.id === 'table:create:users')?.spec.create?.schema).toBe('dbo');
    expect(changes.find((change) => change.id === 'table:drop:legacy')?.destructive).toBe(true);
  });

  it('detects column, index and foreign-key drift', () => {
    const source = snapshot('public', [{
      schema: 'public', name: 'orders',
      columns: [
        { name: 'id', dataType: 'bigint', nullable: false, isPrimaryKey: true },
        { name: 'user_id', dataType: 'integer', nullable: false, isPrimaryKey: false },
      ],
      indexes: [{ name: 'ix_orders_user', columns: ['user_id'], unique: false }],
      foreignKeys: [{ name: 'fk_orders_user', columns: ['user_id'], refTable: 'users', refColumns: ['id'] }],
    }]);
    const target = snapshot('public', [{
      schema: 'public', name: 'orders',
      columns: [{ name: 'id', dataType: 'integer', nullable: false, isPrimaryKey: true }],
      indexes: [], foreignKeys: [],
    }]);
    expect(diffSchemas(source, target).map((change) => change.kind)).toEqual(['column', 'column', 'index', 'foreign-key']);
    const fk = diffSchemas(source, snapshot('dbo', [{ ...target.tables[0], schema: 'dbo' }]))
      .find((change) => change.id === 'fk:add:orders:fk_orders_user')?.spec.alter?.actions[0];
    expect(fk?.kind === 'addForeignKey' ? fk.fk.refSchema : undefined).toBe('dbo');
  });
});
