/** Stateless widgets (tables, states, detail header, tabs, stream log) come
 *  from the SDK UI lib. `listView` stays local because its volatile row cache is
 *  shared with generic-domain's findRow + invalidateRows (core/state.ts). */
import { button, clear, div, el, emptyBox, errorBox, input, loadingBox, setChildren } from '@mcp/plugin-sdk/ui';
import { cache } from './state.js';
import { t } from './i18n.js';

export {
  autoTable as dataTable,
  status,
  detailHeader,
  tabsBar,
  streamLog,
  loadingBox,
  emptyBox,
  errorBox,
  jsonPre,
} from '@mcp/plugin-sdk/ui';
export type { StreamLog, Column, RowAction, StatusKind } from '@mcp/plugin-sdk/ui';

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
