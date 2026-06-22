/** Data table primitives: a typed `dataTable` (status pills + hover row actions,
 *  Podman-Desktop feel) and the legacy auto-columns `autoTable`. */
import { div, el, iconBtn } from './dom.js';
import { kitLabel } from './labels.js';
import { emptyBox } from './states.js';
import type { Row } from './api.js';

export type StatusKind = 'ok' | 'warn' | 'err' | 'info' | 'muted';

/** A pill with a leading dot — for a status/state cell. */
export function status(kind: StatusKind, label: string): HTMLElement {
  return el('span', `mcp-status ${kind}`, label);
}

export interface Column<T> {
  header: string;
  /** Cell content: a string (truncated, title-tipped) or a Node (e.g. a pill). */
  cell: (row: T) => string | Node;
  mono?: boolean;
  num?: boolean;
}

export interface RowAction<T> {
  icon: string;
  title: string;
  onClick: (row: T) => void;
  danger?: boolean;
}

export interface TableSpec<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  actions?: RowAction<T>[];
  onPick?: (row: T) => void;
  selectedKey?: string | null;
  empty?: string;
}

function cellClass(c: { mono?: boolean; num?: boolean }): string | null {
  return [c.mono ? 'mono' : '', c.num ? 'num' : ''].filter(Boolean).join(' ') || null;
}

/** Typed, sticky-header table. Returns an empty state when there are no rows. */
export function dataTable<T>(spec: TableSpec<T>): HTMLElement {
  if (!spec.rows.length) return emptyBox(spec.empty ?? kitLabel('noRows'));
  const wrap = div('mcp-dtable');
  const table = el('table');
  const head = el('tr');
  for (const c of spec.columns) head.appendChild(el('th', c.num ? 'num' : null, c.header));
  if (spec.actions?.length) head.appendChild(el('th', 'mcp-cell-actions', kitLabel('actions')));
  table.appendChild(head);

  const body = el('tbody');
  for (const row of spec.rows) {
    const key = spec.rowKey(row);
    const tr = el('tr');
    const cls = [spec.onPick ? 'pick' : '', spec.selectedKey != null && spec.selectedKey === key ? 'selected' : '']
      .filter(Boolean)
      .join(' ');
    if (cls) tr.className = cls;
    if (spec.onPick) tr.onclick = () => spec.onPick!(row);
    for (const c of spec.columns) {
      const td = el('td', cellClass(c));
      const v = c.cell(row);
      if (typeof v === 'string') {
        td.textContent = v;
        td.title = v;
      } else {
        td.appendChild(v);
      }
      tr.appendChild(td);
    }
    if (spec.actions?.length) {
      const td = el('td', 'mcp-cell-actions');
      const bar = div('mcp-row-actions');
      for (const a of spec.actions) {
        bar.appendChild(
          iconBtn(a.icon, a.title, (ev) => {
            ev.stopPropagation();
            a.onClick(row);
          }, a.danger ? 'danger' : undefined),
        );
      }
      td.appendChild(bar);
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
  table.appendChild(body);
  wrap.appendChild(table);
  return wrap;
}

function cellText(v: unknown): string {
  if (v == null) return '';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/**
 * Untyped table inferring columns from the union of row keys (legacy helper for
 * raw structured rows). Renders the polished `.mcp-dtable` with mono cells and
 * hover-revealed row actions, so callers passing `(rows, actions)` upgrade for
 * free.
 */
export function autoTable(rows: Row[], actions?: (row: Row) => HTMLElement[]): HTMLElement {
  if (!rows.length) return emptyBox(kitLabel('noRows'));
  const cols: string[] = [];
  for (const row of rows) for (const k of Object.keys(row)) if (!cols.includes(k)) cols.push(k);
  const wrap = div('mcp-dtable');
  const table = el('table');
  const head = el('tr');
  for (const c of cols) head.appendChild(el('th', null, c));
  if (actions) head.appendChild(el('th', 'mcp-cell-actions', kitLabel('actions')));
  table.appendChild(head);
  const body = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    for (const c of cols) {
      const td = el('td', 'mono', cellText(row[c]));
      td.title = cellText(row[c]);
      tr.appendChild(td);
    }
    if (actions) {
      const td = el('td', 'mcp-cell-actions');
      const bar = div('mcp-row-actions');
      for (const b of actions(row)) bar.appendChild(b);
      td.appendChild(bar);
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
  table.appendChild(body);
  wrap.appendChild(table);
  return wrap;
}
