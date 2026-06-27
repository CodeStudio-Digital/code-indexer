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

/** Every `value="..."` payload (delimited by real quotes; inner quotes are &quot;). */
function valueAttrs(xml: string): string[] {
  return [...xml.matchAll(/value="([^"]*)"/g)].map((m) => m[1]);
}

describe('buildErXml', () => {
  it('emits a mxGraphModel with a vertex per table and an edge per FK', () => {
    const xml = buildErXml(tables);
    expect(xml).toContain('<mxGraphModel');
    expect(xml).toContain('vertex="1"');
    expect(xml).toContain('users'); // table name present as label text
    expect(xml).toContain('🔑 id : int');
    expect((xml.match(/edge="1"/g) ?? []).length).toBe(1);
  });

  it('entity-escapes the HTML markup so the value attribute is valid XML', () => {
    const xml = buildErXml(tables);
    const values = valueAttrs(xml);
    expect(values.length).toBeGreaterThan(0);
    // The bug: raw `<b>`/`<br/>` inside value="..." → "Unescaped '<' in attribute".
    for (const v of values) expect(v).not.toContain('<');
    // Markup is present, but escaped.
    expect(xml).toContain('&lt;b&gt;');
    expect(xml).toContain('&lt;br/&gt;');
  });

  it('double-escapes special characters in names without breaking the attribute', () => {
    const xml = buildErXml([{ schema: 's', name: 'a<b>&"c', columns: [], foreignKeys: [] }]);
    for (const v of valueAttrs(xml)) expect(v).not.toContain('<');
    // name esc'd for HTML then the whole value esc'd for XML → `<` becomes `&amp;lt;`.
    expect(xml).toContain('a&amp;lt;b&amp;gt;&amp;amp;&amp;quot;c');
  });

  it('skips FK edges to tables outside the set', () => {
    const xml = buildErXml([tables[1]]); // posts only; users not present
    expect((xml.match(/edge="1"/g) ?? []).length).toBe(0);
  });
});
