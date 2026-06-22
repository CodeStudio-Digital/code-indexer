/** Layout primitives: master-detail shell with an icon nav-rail, page header
 *  (title + primary action + search/filters), stat tiles, and a tab bar. */
import { button, clear, div, el, icon, input } from './dom.js';

export interface NavItem {
  id: string;
  label: string;
  icon?: string;
  /** Section header above the item (uppercase). New group → new header. */
  group?: string;
  count?: number;
}

function navButton(it: NavItem, active: boolean): HTMLButtonElement {
  const b = el('button', `mcp-nav${active ? ' active' : ''}`);
  b.type = 'button';
  const ic = div('mcp-nav-icon');
  if (it.icon) ic.appendChild(icon(it.icon, 16));
  b.appendChild(ic);
  b.appendChild(el('span', 'mcp-nav-label', it.label));
  if (it.count != null) b.appendChild(el('span', 'mcp-nav-count', String(it.count)));
  return b;
}

/** Standalone section-grouped icon rail (no content management). */
export function navRail(items: NavItem[], active: string, onSelect: (id: string) => void): HTMLElement {
  const rail = div('mcp-rail');
  let group: string | undefined;
  for (const it of items) {
    if (it.group && it.group !== group) {
      group = it.group;
      rail.appendChild(el('div', 'mcp-rail-group', it.group));
    }
    const b = navButton(it, it.id === active);
    b.onclick = () => onSelect(it.id);
    rail.appendChild(b);
  }
  return rail;
}

export interface MasterDetailSpec {
  items: NavItem[];
  active: string;
  renderContent: (host: HTMLElement, id: string) => void;
  /** Called after a nav switch for side effects (reset filters, persist, …). */
  onSelect?: (id: string) => void;
  /** Present → 3-column shell with a detail pane re-rendered on each switch. */
  renderDetail?: (host: HTMLElement, id: string) => void;
}

/** Master-detail shell: a stable icon rail that swaps the content pane (and an
 *  optional detail pane) on selection — the rail isn't rebuilt, so it's smooth. */
export function masterDetail(spec: MasterDetailSpec): HTMLElement {
  const shell = div('mcp-shell');
  const content = div('mcp-content');
  const detail = spec.renderDetail ? div('mcp-detail') : undefined;
  const navButtons = new Map<string, HTMLButtonElement>();
  let group: string | undefined;
  const rail = div('mcp-rail');

  const paint = (id: string) => {
    clear(content);
    spec.renderContent(content, id);
    if (detail) {
      clear(detail);
      spec.renderDetail!(detail, id);
    }
  };
  const select = (id: string) => {
    for (const [k, b] of navButtons) b.classList.toggle('active', k === id);
    paint(id);
    spec.onSelect?.(id);
  };

  for (const it of spec.items) {
    if (it.group && it.group !== group) {
      group = it.group;
      rail.appendChild(el('div', 'mcp-rail-group', it.group));
    }
    const b = navButton(it, it.id === spec.active);
    b.onclick = () => select(it.id);
    navButtons.set(it.id, b);
    rail.appendChild(b);
  }

  shell.append(rail, content);
  if (detail) {
    shell.classList.add('has-detail');
    shell.appendChild(detail);
  }
  paint(spec.active);
  return shell;
}

export interface HeaderAction {
  label: string;
  icon?: string;
  onClick: () => void;
}

export interface PageHeaderSpec {
  title: string;
  subtitle?: string;
  primary?: HeaderAction;
  /** Extra action elements left of the primary button. */
  actions?: HTMLElement[];
  search?: { placeholder?: string; value?: string; onInput: (value: string) => void };
  /** Filter controls (selects, etc.) on the tools row. */
  filters?: HTMLElement[];
}

export function pageHeader(spec: PageHeaderSpec): HTMLElement {
  const head = div('mcp-page-head');
  const bar = div('mcp-page-bar');
  const titles = div('mcp-page-titles', el('h2', 'mcp-page-title', spec.title));
  if (spec.subtitle) titles.appendChild(el('p', 'mcp-page-sub', spec.subtitle));
  bar.appendChild(titles);

  if (spec.primary || spec.actions?.length) {
    const acts = div('mcp-page-actions');
    for (const a of spec.actions ?? []) acts.appendChild(a);
    if (spec.primary) {
      const b = button(spec.primary.label, 'primary sm', spec.primary.onClick);
      if (spec.primary.icon) b.insertBefore(icon(spec.primary.icon, 15), b.firstChild);
      acts.appendChild(b);
    }
    bar.appendChild(acts);
  }
  head.appendChild(bar);

  if (spec.search || spec.filters?.length) {
    const tools = div('mcp-page-tools');
    if (spec.search) {
      const inp = input(spec.search.placeholder, 'search');
      inp.classList.add('mcp-grow');
      if (spec.search.value) inp.value = spec.search.value;
      inp.oninput = () => spec.search!.onInput(inp.value);
      tools.appendChild(inp);
    }
    for (const f of spec.filters ?? []) tools.appendChild(f);
    head.appendChild(tools);
  }
  return head;
}

export interface Stat {
  label: string;
  value: string;
  delta?: { dir: 'up' | 'down'; text: string };
}

export function statTiles(stats: Stat[]): HTMLElement {
  const grid = div('mcp-stats');
  for (const s of stats) {
    const tile = div('mcp-stat', el('div', 'mcp-stat-label', s.label), el('div', 'mcp-stat-value', s.value));
    if (s.delta) tile.appendChild(el('div', `mcp-stat-delta ${s.delta.dir}`, s.delta.text));
    grid.appendChild(tile);
  }
  return grid;
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
