/** Drill-in list view (search + reload + create over a row list) and a detail
 *  header. The volatile row cache lives here so back-navigation is instant;
 *  `invalidateRows` drops it after a mutation. */
import { button, clear, div, el, iconBtn, input, setChildren } from './dom.js';
import { kitLabel } from './labels.js';
import { emptyBox, errorBox, loadingBox } from './states.js';

const rowCache = new Map<string, unknown[]>();

/** Drop cached list rows. No prefix → clear all; prefix → matching keys only. */
export function invalidateRows(prefix?: string): void {
  if (!prefix) {
    rowCache.clear();
    return;
  }
  for (const k of [...rowCache.keys()]) if (k.startsWith(prefix)) rowCache.delete(k);
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
  const search = input(spec.searchPlaceholder ?? kitLabel('filter'));
  search.classList.add('mcp-grow');
  const body = div('mcp-scroll mcp-grow');
  let items: T[] = (rowCache.get(spec.cacheKey) as T[] | undefined) ?? [];

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
      body.appendChild(emptyBox(kitLabel('noMatches')));
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
    if (!force && rowCache.has(spec.cacheKey)) {
      items = rowCache.get(spec.cacheKey) as T[];
      renderRows();
      return;
    }
    setChildren(body, loadingBox());
    try {
      items = await spec.load();
      rowCache.set(spec.cacheKey, items as unknown[]);
      renderRows();
    } catch (e) {
      setChildren(body, errorBox(e));
    }
  };

  search.oninput = renderRows;
  toolbar.append(search, iconBtn('refresh-cw', 'Reload', () => void load(true)));
  if (spec.onCreate) toolbar.appendChild(button(kitLabel('create'), 'primary sm', spec.onCreate));
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
