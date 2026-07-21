import { describe, expect, it } from 'vitest';
import { incomingRelationTargets, outgoingRelationTargets } from '../RelatedRowsDialog.js';
import type { DbIncomingForeignKey, DbTableInfo } from '../../types.js';

describe('related-row targets', () => {
  const row = { id: 42, tenant_id: 'acme', owner_id: 7 };
  const tableInfo: DbTableInfo = {
    schema: 'app',
    name: 'orders',
    columns: [],
    foreignKeys: [{
      name: 'fk_orders_owner',
      columns: ['tenant_id', 'owner_id'],
      refSchema: 'auth',
      refTable: 'users',
      refColumns: ['tenant_id', 'id'],
    }],
  };

  it('maps outgoing composite keys to the referenced table', () => {
    expect(outgoingRelationTargets(tableInfo, row, 'app')).toMatchObject([{
      schema: 'auth',
      table: 'users',
      where: [
        { column: 'tenant_id', op: '=', value: 'acme' },
        { column: 'id', op: '=', value: '7' },
      ],
    }]);
  });

  it('maps incoming composite keys back to the source table', () => {
    const incoming: DbIncomingForeignKey[] = [{
      schema: 'billing',
      table: 'invoices',
      foreignKey: {
        name: 'fk_invoices_order',
        columns: ['tenant_id', 'order_id'],
        refSchema: 'app',
        refTable: 'orders',
        refColumns: ['tenant_id', 'id'],
      },
    }];

    expect(incomingRelationTargets(incoming, row, 'orders')).toMatchObject([{
      schema: 'billing',
      table: 'invoices',
      where: [
        { column: 'tenant_id', op: '=', value: 'acme' },
        { column: 'order_id', op: '=', value: '42' },
      ],
    }]);
  });
});
