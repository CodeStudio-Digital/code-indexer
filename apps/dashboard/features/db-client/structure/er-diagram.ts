/**
 * Build a draw.io / mxGraph XML document for an ER diagram from introspected
 * tables (columns + foreign keys). Pure + dependency-free so it's testable; the
 * rendering is handled by the reused `DrawioFrame`. Tables lay out in a grid;
 * foreign keys become edges between table boxes.
 */
import type { DbTableInfo } from '../types.js';

const ROW_H = 16;
const HEAD_H = 26;
const BOX_W = 200;
const COL_GAP = 60;
const ROW_GAP = 50;
const PER_ROW = 4;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function cellId(name: string, i: number): string {
  return `tbl_${name.replace(/[^A-Za-z0-9_]/g, '_')}_${i}`;
}

export function buildErXml(tables: DbTableInfo[]): string {
  const idByTable = new Map<string, string>();
  tables.forEach((t, i) => idByTable.set(t.name, cellId(t.name, i)));

  const cells: string[] = [];
  tables.forEach((t, i) => {
    const col = i % PER_ROW;
    const row = Math.floor(i / PER_ROW);
    const x = 40 + col * (BOX_W + COL_GAP);
    // Stagger Y by the tallest box in the row would be ideal; a fixed generous gap keeps it simple.
    const y = 40 + row * (HEAD_H + 12 * ROW_H + ROW_GAP);
    const height = HEAD_H + Math.max(1, t.columns.length) * ROW_H + 8;
    const lines = t.columns
      .map((c) => {
        const label = `${esc(c.name)} : ${esc(c.dataType)}`;
        return c.isPrimaryKey ? `<b>🔑 ${label}</b>` : label;
      })
      .join('<br/>');
    // draw.io's `value` attribute carries HTML (html=1) but the attribute itself
    // is XML — the `<b>`/`<br/>` markup must be entity-escaped or the parser
    // rejects the unescaped `<`. (Names inside are already esc'd → double-escaped,
    // which is exactly the form draw.io un-escapes back to HTML.)
    const html = `<b>${esc(t.name)}</b><br/>${lines}`;
    const value = esc(html);
    const style =
      'rounded=0;whiteSpace=wrap;html=1;align=left;verticalAlign=top;spacingLeft=6;spacingTop=4;fillColor=#1e293b;strokeColor=#475569;fontColor=#e2e8f0;';
    cells.push(
      `<mxCell id="${idByTable.get(t.name)}" value="${value}" style="${style}" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="${BOX_W}" height="${height}" as="geometry"/></mxCell>`,
    );
  });

  let edgeN = 0;
  for (const t of tables) {
    for (const fk of t.foreignKeys ?? []) {
      const source = idByTable.get(t.name);
      const target = idByTable.get(fk.refTable);
      if (!source || !target) continue;
      edgeN += 1;
      cells.push(
        `<mxCell id="e_${edgeN}" style="edgeStyle=entityRelationEdgeStyle;rounded=0;html=1;endArrow=ERmany;startArrow=ERone;strokeColor=#94a3b8;" edge="1" parent="1" source="${source}" target="${target}"><mxGeometry relative="1" as="geometry"/></mxCell>`,
      );
    }
  }

  return `<mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells.join('')}</root></mxGraphModel>`;
}
