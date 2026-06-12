/**
 * DNS views:
 *  - dns       : zones list
 *  - dns-zone  {zoneId, name}: records (search + CRUD), export, scan, cache purge
 *  - dns-edit  {zoneId, recordId?, …}: create/edit form for one record
 */
import { button, div, field, input, select, setChildren } from '../core/dom.js';
import { call, mutate, rowsOf } from '../core/api.js';
import { pop, push, registerView } from '../core/router.js';
import { dataTable, detailHeader, errorBox, jsonPre, listView, loadingBox } from '../core/widgets.js';
import { t } from '../core/i18n.js';

const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'SRV', 'CAA'];

interface ZoneRow {
  id?: string;
  name?: string;
  status?: string;
}

function renderZones(host: HTMLElement): void {
  listView<ZoneRow>(host, {
    cacheKey: 'dns',
    load: async () => rowsOf(await call('cf_zones_list')) as ZoneRow[],
    row: (z) => ({ title: String(z.name ?? '?'), meta: `${z.id ?? ''}${z.status ? ` · ${z.status}` : ''}` }),
    onPick: (z) => push('dns-zone', { zoneId: String(z.id ?? ''), name: String(z.name ?? '') }),
  });
}

function renderZone(host: HTMLElement, params: Record<string, string>): void {
  const zoneId = params.zoneId;
  const grid = div('mcp-grow');
  host.appendChild(
    detailHeader(params.name || zoneId, zoneId, [
      button(t('dns.addRecord'), 'primary sm', () => push('dns-edit', { zoneId })),
      button(t('d1.export'), 'sm', async () => {
        setChildren(grid, loadingBox());
        try {
          const r = await call('cf_dns_export', { zoneId });
          setChildren(grid, jsonPre(r.content));
        } catch (e) {
          setChildren(grid, errorBox(e));
        }
      }),
      button(t('dns.purgeCache'), 'danger sm', () =>
        void mutate('cf_cache_purge', { zoneId }, {
          danger: t('dns.purgeCacheTitle'),
          detail: params.name || zoneId,
        }),
      ),
    ]),
  );

  const search = input(t('dns.searchPh'));
  search.classList.add('mcp-grow');
  const load = async () => {
    setChildren(grid, loadingBox());
    try {
      const r = await call('cf_dns_list', { zoneId, search: search.value.trim() || undefined });
      setChildren(
        grid,
        dataTable(rowsOf(r), (row) => [
          button(t('common.edit'), 'sm', () =>
            push('dns-edit', {
              zoneId,
              recordId: String(row.id ?? ''),
              type: String(row.type ?? 'A'),
              name: String(row.name ?? ''),
              content: String(row.content ?? ''),
              ttl: row.ttl != null ? String(row.ttl) : '',
              proxied: row.proxied ? '1' : '',
            }),
          ),
          button(t('common.delete'), 'danger sm', async () => {
            const ok = await mutate('cf_dns_delete', { zoneId, recordId: String(row.id) }, {
              danger: t('dns.deleteTitle'),
              detail: `${row.type} ${row.name}`,
            });
            if (ok) void load();
          }),
        ]),
      );
    } catch (e) {
      setChildren(grid, errorBox(e));
    }
  };
  search.onkeydown = (e) => {
    if (e.key === 'Enter') void load();
  };
  host.append(
    div('mcp-toolbar', search, button(t('dns.loadRecords'), 'sm', () => void load())),
    grid,
  );
  void load();
}

function renderEdit(host: HTMLElement, params: Record<string, string>): void {
  const { zoneId } = params;
  const isNew = !params.recordId;
  const type = select(
    RECORD_TYPES.map((v) => ({ value: v, label: v, selected: v === (params.type || 'A') })),
  );
  const name = input('api.example.com');
  name.value = params.name ?? '';
  const content = input('203.0.113.7');
  content.value = params.content ?? '';
  const ttl = input(t('dns.ttlPh'), 'number');
  ttl.value = params.ttl ?? '';
  const proxied = select([
    { value: '', label: t('common.no'), selected: !params.proxied },
    { value: '1', label: t('common.yes'), selected: !!params.proxied },
  ]);

  host.appendChild(
    detailHeader(isNew ? t('dns.addRecord') : `${params.type} ${params.name}`, zoneId, [
      button(t('common.save'), 'primary sm', async () => {
        const body: Record<string, unknown> = {
          type: type.value,
          name: name.value.trim(),
          content: content.value.trim(),
        };
        if (ttl.value) body.ttl = Number(ttl.value);
        body.proxied = proxied.value === '1';
        const r = isNew
          ? await mutate('cf_dns_create', { zoneId, ...body })
          : await mutate('cf_dns_update', { zoneId, recordId: params.recordId, body });
        if (r) pop();
      }),
    ]),
  );
  host.append(
    field(t('dns.typeLabel'), type),
    field(t('dns.nameLabel'), name),
    field(t('dns.contentLabel'), content),
    field(t('dns.ttlLabel'), ttl, t('dns.ttlHint')),
    field(t('dns.proxiedLabel'), proxied),
  );
}

export function registerDnsViews(): void {
  registerView({ id: 'dns', label: () => t('dns.title'), render: renderZones });
  registerView({ id: 'dns-zone', label: (p) => p.name || 'DNS', render: renderZone });
  registerView({
    id: 'dns-edit',
    label: (p) => (p.recordId ? t('dns.editRecord') : t('dns.addRecord')),
    render: renderEdit,
  });
}
