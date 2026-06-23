/**
 * Data-driven renderer for the compact domains (see domain-configs.ts):
 *  - generic      {domain}: list via config.listTool
 *  - generic-item {domain, key}: row JSON + config actions; action results
 *    render as a table when the tool returns rows, else as JSON. Falls back
 *    to the raw `content` when a tool ships no structured data.
 */
import { button, div, setChildren } from '../core/dom.js';
import { call, confirmDanger, errorMessage, rowsOf, toast, type Row } from '../core/api.js';
import { cache, invalidateRows } from '../core/state.js';
import { pop, push, registerView } from '../core/router.js';
import { dataTable, detailHeader, emptyBox, errorBox, jsonPre, listView, loadingBox } from '../core/widgets.js';
import { DOMAIN_CONFIGS, type DomainAction, type DomainConfig } from './domain-configs.js';
import { t } from '../core/i18n.js';

function cfg(params: Record<string, string>): DomainConfig | null {
  return DOMAIN_CONFIGS[params.domain] ?? null;
}

function renderList(host: HTMLElement, params: Record<string, string>): void {
  const config = cfg(params);
  if (!config) {
    host.appendChild(emptyBox(t('common.noMatches')));
    return;
  }
  listView<Row>(host, {
    cacheKey: `generic:${config.id}`,
    load: async () => rowsOf(await call(config.listTool)),
    row: (r) => ({ title: config.title(r), meta: config.meta(r) }),
    onPick: (r) =>
      config.actions.length || config.openWith
        ? push('generic-item', { domain: config.id, key: config.key(r), title: config.title(r) })
        : undefined,
  });
}

async function findRow(config: DomainConfig, key: string): Promise<Row | null> {
  const cacheKey = `generic:${config.id}`;
  let rows = cache.rows.get(cacheKey) as Row[] | undefined;
  if (!rows) {
    rows = rowsOf(await call(config.listTool));
    cache.rows.set(cacheKey, rows);
  }
  return rows.find((r) => config.key(r) === key) ?? null;
}

function renderResult(body: HTMLElement, r: { content: string; data?: unknown }): void {
  const rows = rowsOf(r);
  if (rows.length) {
    setChildren(body, dataTable(rows));
    return;
  }
  const data = r.data as { details?: unknown } | undefined;
  setChildren(body, jsonPre(data?.details ?? r.data ?? r.content));
}

function renderItem(host: HTMLElement, params: Record<string, string>): void {
  const config = cfg(params);
  if (!config) {
    host.appendChild(emptyBox(t('common.noMatches')));
    return;
  }
  const body = div('mcp-grow');
  setChildren(host, loadingBox());

  void findRow(config, params.key).then((row) => {
    if (!row) {
      setChildren(host, errorBox(new Error(t('common.noMatches'))));
      return;
    }
    const runAction = async (action: DomainAction) => {
      if (action.dangerKey) {
        const ok = await confirmDanger(t(action.dangerKey), config.title(row));
        if (!ok) return;
      }
      setChildren(body, loadingBox());
      try {
        const r = await call(action.tool, action.args(row));
        if (action.showsResult) {
          renderResult(body, r);
        } else {
          toast('success', r.content || t('common.done'));
          setChildren(body, jsonPre(row));
        }
        if (config.reloadsList?.includes(action.tool)) {
          invalidateRows(`generic:${config.id}`);
          pop();
        }
      } catch (e) {
        if (action.showsResult) setChildren(body, errorBox(e));
        else toast('error', errorMessage(e));
      }
    };

    const actionButtons = config.actions.map((a) =>
      button(t(a.labelKey), a.dangerKey ? 'danger sm' : 'sm', () => void runAction(a)),
    );
    setChildren(
      host,
      detailHeader(config.title(row), config.meta(row), actionButtons),
      body,
    );
    if (config.openWith) void runAction(config.openWith);
    else setChildren(body, jsonPre(row));
  });
}

export function registerGenericViews(): void {
  registerView({
    id: 'generic',
    label: (p) => t(DOMAIN_CONFIGS[p.domain]?.titleKey ?? 'common.loading'),
    render: renderList,
  });
  registerView({
    id: 'generic-item',
    label: (p) => p.title || p.key || '…',
    render: renderItem,
  });
}
