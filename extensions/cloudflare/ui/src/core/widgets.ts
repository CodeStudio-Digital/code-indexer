/** Composite widgets over the host UI kit: states, tables, drill-in lists,
 *  detail headers, tabs and live stream logs. */
import { button, clear, div, el, input, setChildren } from './dom.js';
import { errorMessage, type Row } from './api.js';
import { cache } from './state.js';
import { mcp, type StreamChunk } from './mcp.js';
import { t } from './i18n.js';

export function loadingBox(label?: string): HTMLElement {
  return div('mcp-loading', el('span', 'mcp-spinner'), el('span', null, label ?? t('common.loading')));
}

export function emptyBox(message: string, icon = '·'): HTMLElement {
  return div('mcp-empty', el('div', 'mcp-empty-icon', icon), el('div', null, message));
}

export function errorBox(e: unknown): HTMLElement {
  return div('mcp-empty', el('div', 'mcp-empty-icon', '⚠'), el('div', null, errorMessage(e)));
}

export function jsonPre(value: unknown): HTMLElement {
  const pre = el('pre', 'mcp-log');
  pre.textContent = typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 2);
  return pre;
}

function cellText(v: unknown): string {
  if (v == null) return '';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/** Sticky-header table from row objects (union of keys = columns). */
export function dataTable(rows: Row[], actions?: (row: Row) => HTMLElement[]): HTMLElement {
  if (!rows.length) return emptyBox(t('common.noRows'));
  const cols: string[] = [];
  for (const row of rows) for (const k of Object.keys(row)) if (!cols.includes(k)) cols.push(k);
  const wrap = div('mcp-table');
  const table = el('table');
  const head = el('tr');
  for (const c of cols) head.appendChild(el('th', null, c));
  if (actions) head.appendChild(el('th', null, t('common.actions')));
  table.appendChild(head);
  for (const row of rows) {
    const tr = el('tr');
    for (const c of cols) {
      const td = el('td', null, cellText(row[c]));
      td.title = cellText(row[c]);
      tr.appendChild(td);
    }
    if (actions) {
      const td = el('td');
      for (const b of actions(row)) td.appendChild(b);
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  wrap.appendChild(table);
  return wrap;
}

export interface ListSpec<T> {
  /** Volatile cache key — back navigation re-renders instantly. */
  cacheKey: string;
  load(): Promise<T[]>;
  row(item: T): { title: string; meta?: string };
  onPick(item: T): void;
  onCreate?: () => void;
  searchPlaceholder?: string;
}

/** Search + reload + create toolbar over a drill-in row list. */
export function listView<T>(host: HTMLElement, spec: ListSpec<T>): void {
  const toolbar = div('mcp-toolbar');
  const search = input(spec.searchPlaceholder ?? t('common.filter'));
  search.classList.add('mcp-grow');
  const body = div('mcp-scroll mcp-grow');
  let items: T[] = (cache.rows.get(spec.cacheKey) as T[] | undefined) ?? [];

  const renderRows = () => {
    const needle = search.value.trim().toLowerCase();
    const visible = needle
      ? items.filter((it) => {
          const r = spec.row(it);
          return `${r.title} ${r.meta ?? ''}`.toLowerCase().includes(needle);
        })
      : items;
    clear(body);
    if (!visible.length) {
      body.appendChild(emptyBox(t('common.noMatches')));
      return;
    }
    const list = div('mcp-list');
    for (const it of visible) {
      const r = spec.row(it);
      const rowBtn = el('button', 'mcp-row');
      rowBtn.type = 'button';
      const main = div('mcp-row-main', el('span', 'mcp-row-title', r.title));
      if (r.meta) main.appendChild(el('span', 'mcp-row-meta', r.meta));
      rowBtn.append(main, el('span', 'mcp-row-chev', '›'));
      rowBtn.onclick = () => spec.onPick(it);
      list.appendChild(rowBtn);
    }
    body.appendChild(list);
  };

  const load = async (force: boolean) => {
    if (!force && cache.rows.has(spec.cacheKey)) {
      items = cache.rows.get(spec.cacheKey) as T[];
      renderRows();
      return;
    }
    setChildren(body, loadingBox());
    try {
      items = await spec.load();
      cache.rows.set(spec.cacheKey, items as unknown[]);
      renderRows();
    } catch (e) {
      setChildren(body, errorBox(e));
    }
  };

  search.oninput = renderRows;
  toolbar.append(search, button('⟳', 'sm', () => void load(true)));
  if (spec.onCreate) toolbar.appendChild(button(t('common.create'), 'primary sm', spec.onCreate));
  host.append(toolbar, body);
  void load(false);
}

/** Detail header: title + meta line + action buttons, truncation-safe. */
export function detailHeader(title: string, meta: string, actions: HTMLElement[]): HTMLElement {
  const head = div('mcp-stack');
  const titleRow = div('mcp-hstack');
  titleRow.appendChild(el('span', 'mcp-row-title mcp-grow', title));
  head.appendChild(titleRow);
  if (meta) head.appendChild(el('span', 'mcp-row-meta mcp-mono', meta));
  if (actions.length) {
    const bar = div('mcp-toolbar');
    for (const a of actions) bar.appendChild(a);
    head.appendChild(bar);
  }
  return head;
}

export function tabsBar(
  items: Array<{ id: string; label: string }>,
  active: string,
  onPick: (id: string) => void,
): HTMLElement {
  const bar = div('mcp-tabs');
  for (const it of items) {
    const b = el('button', `mcp-tab${it.id === active ? ' active' : ''}`, it.label);
    b.type = 'button';
    b.onclick = () => onPick(it.id);
    bar.appendChild(b);
  }
  return bar;
}

export interface StreamLog {
  node: HTMLElement;
  append(text: string): void;
  /** Run `cmd args…` streaming into the log; returns when wired (not done). */
  start(cmd: string, args: string[]): void;
  stop(): void;
  running(): boolean;
}

/** Live command output block (deploy/build/tail) with autoscroll. */
export function streamLog(onStateChange?: () => void): StreamLog {
  const pre = el('pre', 'mcp-log');
  let close: (() => void) | null = null;
  const append = (s: string) => {
    pre.textContent += s;
    pre.scrollTop = pre.scrollHeight;
  };
  const stop = () => {
    if (close) {
      close();
      close = null;
      append(`\n${t('stream.stopped')}\n`);
      onStateChange?.();
    }
  };
  return {
    node: pre,
    append,
    running: () => close !== null,
    stop,
    start(cmd, args) {
      stop();
      append(`$ ${cmd} ${args.join(' ')}\n`);
      close = mcp.execStream(cmd, args, {
        onData: (c: StreamChunk) => {
          if (c && c.type === 'data' && c.data) append(c.data);
        },
        onEnd: () => {
          close = null;
          append(`\n${t('stream.done')}\n`);
          onStateChange?.();
        },
        onError: (m) => {
          close = null;
          append(`\n[error] ${m}\n`);
          onStateChange?.();
        },
      });
      onStateChange?.();
    },
  };
}
