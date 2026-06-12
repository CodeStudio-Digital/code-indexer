/**
 * KV views:
 *  - kv     : namespaces list (create/rename/delete via drill-in)
 *  - kv-ns  {id, title}: keys (prefix filter) → kv-key editor
 *  - kv-key {id, key}: read/edit/delete one value
 */
import { button, div, field, input, setChildren, textarea } from '../core/dom.js';
import { call, detailsOf, mutate, rowsOf } from '../core/api.js';
import { invalidateRows } from '../core/state.js';
import { pop, push, refresh, registerView } from '../core/router.js';
import { dataTable, detailHeader, errorBox, listView, loadingBox } from '../core/widgets.js';
import { mcp } from '../core/mcp.js';
import { t } from '../core/i18n.js';

interface NsRow {
  id?: string;
  title?: string;
}

function renderNamespaces(host: HTMLElement): void {
  listView<NsRow>(host, {
    cacheKey: 'kv',
    load: async () => rowsOf(await call('cf_kv_list')) as NsRow[],
    row: (ns) => ({ title: String(ns.title ?? ns.id ?? '?'), meta: String(ns.id ?? '') }),
    onPick: (ns) => push('kv-ns', { id: String(ns.id ?? ''), title: String(ns.title ?? '') }),
    onCreate: async () => {
      const title = await mcp.ui.prompt({ title: t('kv.create'), placeholder: t('kv.namePh') });
      if (!title?.trim()) return;
      if (await mutate('cf_kv_create', { title: title.trim() })) {
        invalidateRows('kv');
        refresh();
      }
    },
  });
}

function renderNamespace(host: HTMLElement, params: Record<string, string>): void {
  const id = params.id;
  host.appendChild(
    detailHeader(params.title || id, id, [
      button(t('kv.putKey'), 'primary sm', () => push('kv-key', { id, key: '' })),
      button(t('common.rename'), 'sm', async () => {
        const title = await mcp.ui.prompt({
          title: t('kv.renameTitle'),
          defaultValue: params.title,
        });
        if (!title?.trim()) return;
        if (await mutate('cf_kv_update', { namespaceId: id, title: title.trim() })) {
          invalidateRows('kv');
          pop();
        }
      }),
      button(t('common.delete'), 'danger sm', async () => {
        const r = await mutate('cf_kv_delete', { namespaceId: id }, {
          danger: t('kv.deleteTitle'),
          detail: params.title || id,
        });
        if (r) {
          invalidateRows('kv');
          pop();
        }
      }),
    ]),
  );

  const prefix = input(t('kv.prefixPh'));
  prefix.classList.add('mcp-grow');
  const grid = div('mcp-grow');
  const load = async () => {
    setChildren(grid, loadingBox());
    try {
      const r = await call('cf_kv_keys', {
        namespaceId: id,
        prefix: prefix.value.trim() || undefined,
      });
      setChildren(
        grid,
        dataTable(rowsOf(r), (row) => [
          button(t('common.open'), 'sm', () => push('kv-key', { id, key: String(row.name) })),
          button(t('common.delete'), 'danger sm', async () => {
            const ok = await mutate('cf_kv_delete_key', { namespaceId: id, key: String(row.name) }, {
              danger: t('kv.deleteKeyTitle'),
              detail: String(row.name),
            });
            if (ok) void load();
          }),
        ]),
      );
    } catch (e) {
      setChildren(grid, errorBox(e));
    }
  };
  prefix.onkeydown = (e) => {
    if (e.key === 'Enter') void load();
  };
  host.append(div('mcp-toolbar', prefix, button(t('kv.loadKeys'), 'sm', () => void load())), grid);
  void load();
}

function renderKey(host: HTMLElement, params: Record<string, string>): void {
  const { id } = params;
  const isNew = !params.key;
  const keyInput = input(t('kv.keyPh'));
  keyInput.value = params.key;
  keyInput.disabled = !isNew;
  const value = textarea(t('kv.valuePh'));
  value.classList.add('mono', 'mcp-grow');
  const ttl = input(t('kv.ttlPh'), 'number');

  host.appendChild(
    detailHeader(isNew ? t('kv.putKey') : params.key, id, [
      button(t('common.save'), 'primary sm', async () => {
        const key = keyInput.value.trim();
        if (!key) return;
        const args: Record<string, unknown> = { namespaceId: id, key, value: value.value };
        if (ttl.value) args.expiration_ttl = Number(ttl.value);
        if (await mutate('cf_kv_put', args)) pop();
      }),
      ...(isNew
        ? []
        : [
            button(t('common.delete'), 'danger sm', async () => {
              const r = await mutate('cf_kv_delete_key', { namespaceId: id, key: params.key }, {
                danger: t('kv.deleteKeyTitle'),
                detail: params.key,
              });
              if (r) pop();
            }),
          ]),
    ]),
  );
  host.append(
    field(t('kv.keyLabel'), keyInput),
    field(t('kv.valueLabel'), value),
    field(t('kv.ttlLabel'), ttl, t('kv.ttlHint')),
  );

  if (!isNew) {
    value.value = t('common.loading');
    void call('cf_kv_get', { namespaceId: id, key: params.key })
      .then((r) => {
        const d = detailsOf(r) as { value?: unknown };
        value.value = typeof d.value === 'string' ? d.value : (r.content ?? '');
      })
      .catch(() => {
        value.value = '';
      });
  }
}

export function registerKvViews(): void {
  registerView({ id: 'kv', label: () => t('kv.title'), render: renderNamespaces });
  registerView({ id: 'kv-ns', label: (p) => p.title || p.id || 'KV', render: renderNamespace });
  registerView({
    id: 'kv-key',
    label: (p) => (p.key ? p.key : t('kv.putKey')),
    render: renderKey,
  });
}
