import { describe, it, expect } from 'vitest';
import { buildErXml } from '../er-diagram.js';
import type { DbTableInfo } from '../../types.js';

const tables: DbTableInfo[] = [
  { schema: 'public', name: 'users', columns: [{ name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true }], foreignKeys: [] },
  {
    schema: 'public',
    name: 'posts',
    columns: [
      { name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true },
      { name: 'user_id', dataType: 'int', nullable: false, isPrimaryKey: false },
    ],
    foreignKeys: [{ name: 'fk_user', columns: ['user_id'], refTable: 'users', refColumns: ['id'] }],
  },
];

describe('buildErXml', () => {
  it('emits a mxGraphModel with a vertex per table and an edge per FK', () => {
    const xml = buildErXml(tables);
    expect(xml).toContain('<mxGraphModel');
    expect(xml).toContain('vertex="1"');
    expect(xml).toContain('>users<'); // escaped table name in label
    expect(xml).toContain('🔑 id : int');
    // One FK edge from posts → users.
    expect((xml.match(/edge="1"/g) ?? []).length).toBe(1);
  });

  it('escapes html-special characters in names', () => {
    const xml = buildErXml([{ schema: 's', name: 'a<b>&"c', columns: [], foreignKeys: [] }]);
    expect(xml).toContain('a&lt;b&gt;&amp;&quot;c');
  });

  it('skips FK edges to tables outside the set', () => {
    const xml = buildErXml([tables[1]]); // posts only; users not present
    expect((xml.match(/edge="1"/g) ?? []).length).toBe(0);
  });
});
