import { describe, expect, it } from 'vitest';
import type { DbConnection, DbTreeNode } from '../../types.js';
import { buildConnectionTreeRenderItems } from '../ConnectionTree.js';

const connection = {
  id: 1,
  label: 'Production',
  group_name: 'Shared',
} as DbConnection;

function node(
  id: string,
  kind: DbTreeNode['kind'],
  depth: number,
  label: string,
  extra: Partial<DbTreeNode> = {},
): DbTreeNode {
  return {
    id,
    kind,
    depth,
    label,
    name: label,
    connectionId: 1,
    expandable: kind !== 'column',
    ...extra,
  };
}

describe('buildConnectionTreeRenderItems', () => {
  it('keeps large expanded schemas as a flat virtualizer input', () => {
    const schemaId = 'conn:1/db:main/schema:dbo';
    const rows: DbTreeNode[] = [
      node('conn:1', 'database', 0, 'Production'),
      node('conn:1/db:main', 'database', 1, 'main'),
      node(schemaId, 'schema', 2, 'dbo', { schema: 'dbo' }),
      ...Array.from({ length: 1_500 }, (_, index) =>
        node(`${schemaId}/table:T${index}`, 'table', 3, `T${index}`, {
          schema: 'dbo',
          table: `T${index}`,
        })),
    ];

    const items = buildConnectionTreeRenderItems({
      rows,
      connections: [connection],
      expanded: new Set([schemaId]),
      schemaFilters: {},
    });

    expect(items).toHaveLength(1_505); // group + 3 ancestors + filter + 1,500 tables
    expect(new Set(items.map((item) => item.key)).size).toBe(items.length);
    expect(items[4]).toMatchObject({ kind: 'schema-filter', nodeId: schemaId });
  });

  it('filters direct tables and their descendants while retaining matching subtrees', () => {
    const schemaId = 'conn:1/db:main/schema:dbo';
    const rows: DbTreeNode[] = [
      node('conn:1', 'database', 0, 'Production'),
      node('conn:1/db:main', 'database', 1, 'main'),
      node(schemaId, 'schema', 2, 'dbo', { schema: 'dbo' }),
      node(`${schemaId}/table:ABT_BOMBA`, 'table', 3, 'ABT_BOMBA'),
      node(`${schemaId}/table:ABT_BOMBA/column:id`, 'column', 4, 'id'),
      node(`${schemaId}/table:AST_AREA`, 'table', 3, 'AST_AREA'),
      node(`${schemaId}/table:AST_AREA/column:id`, 'column', 4, 'id'),
    ];

    const items = buildConnectionTreeRenderItems({
      rows,
      connections: [connection],
      expanded: new Set([schemaId]),
      schemaFilters: { [schemaId]: 'bomba' },
    });
    const keys = items.map((item) => item.key);

    expect(keys).toContain(`${schemaId}/table:ABT_BOMBA`);
    expect(keys).toContain(`${schemaId}/table:ABT_BOMBA/column:id`);
    expect(keys).not.toContain(`${schemaId}/table:AST_AREA`);
    expect(keys).not.toContain(`${schemaId}/table:AST_AREA/column:id`);
  });
});
