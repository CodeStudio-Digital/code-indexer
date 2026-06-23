/**
 * R2 views:
 *  - r2        : buckets list (+ create)
 *  - r2-bucket {name}: objects under a prefix; CORS/lifecycle/delete actions
 *  - r2-object {bucket, key}: text editor over one object (size-guarded)
 */
import { button, div, field, input, setChildren, textarea } from '../core/dom.js';
import { call, detailsOf, mutate, rowsOf, toast } from '../core/api.js';
import { invalidateRows } from '../core/state.js';
import { pop, push, refresh, registerView } from '../core/router.js';
import { dataTable, detailHeader, errorBox, jsonPre, listView, loadingBox } from '../core/widgets.js';
import { mcp } from '../core/mcp.js';
import { t } from '../core/i18n.js';

const MAX_EDIT_BYTES = 256 * 1024;

interface BucketRow {
  name?: string;
  creation_date?: string;
}

function renderBuckets(host: HTMLElement): void {
  listView<BucketRow>(host, {
    cacheKey: 'r2',
    load: async () => rowsOf(await call('cf_r2_list')) as BucketRow[],
    row: (b) => ({ title: String(b.name ?? '?'), meta: String(b.creation_date ?? '') }),
    onPick: (b) => push('r2-bucket', { name: String(b.name ?? '') }),
    onCreate: async () => {
      const name = await mcp.ui.prompt({ title: t('r2.create'), placeholder: t('r2.namePh') });
      if (!name?.trim()) return;
      if (await mutate('cf_r2_create', { name: name.trim() })) {
        invalidateRows('r2');
        refresh();
      }
    },
  });
}

function renderBucket(host: HTMLElement, params: Record<string, string>): void {
  const bucket = params.name;
  const grid = div('mcp-grow');
  const showJson = async (tool: string) => {
    setChildren(grid, loadingBox());
    try {
      const r = await call(tool, { bucket });
      setChildren(grid, jsonPre(detailsOf(r)));
    } catch (e) {
      setChildren(grid, errorBox(e));
    }
  };
  host.appendChild(
    detailHeader(bucket, '', [
      button(t('r2.putObject'), 'primary sm', () => push('r2-object', { bucket, key: '' })),
      button('CORS', 'sm', () => void showJson('cf_r2_cors_get')),
      button(t('r2.lifecycle'), 'sm', () => void showJson('cf_r2_lifecycle_get')),
      button(t('common.delete'), 'danger sm', async () => {
        const r = await mutate('cf_r2_delete', { name: bucket }, {
          danger: t('r2.deleteTitle'),
          detail: bucket,
        });
        if (r) {
          invalidateRows('r2');
          pop();
        }
      }),
    ]),
  );

  const prefix = input(t('r2.prefixPh'));
  prefix.classList.add('mcp-grow');
  const load = async () => {
    setChildren(grid, loadingBox());
    try {
      const r = await call('cf_r2_objects', { bucket, prefix: prefix.value.trim() || undefined });
      setChildren(
        grid,
        dataTable(rowsOf(r), (row) => [
          button(t('common.open'), 'sm', () => {
            const size = Number(row.size ?? 0);
            if (size > MAX_EDIT_BYTES) {
              toast('warning', t('r2.tooLarge'));
              return;
            }
            push('r2-object', { bucket, key: String(row.key) });
          }),
          button(t('common.delete'), 'danger sm', async () => {
            const ok = await mutate('cf_r2_object_delete', { bucket, key: String(row.key) }, {
              danger: t('r2.deleteObjectTitle'),
              detail: String(row.key),
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
  host.append(
    div('mcp-toolbar', prefix, button(t('r2.loadObjects'), 'sm', () => void load())),
    grid,
  );
  void load();
}

function renderObject(host: HTMLElement, params: Record<string, string>): void {
  const { bucket } = params;
  const isNew = !params.key;
  const keyInput = input(t('r2.keyPh'));
  keyInput.value = params.key;
  keyInput.disabled = !isNew;
  const contentType = input('text/plain');
  contentType.value = 'text/plain';
  const value = textarea(t('r2.valuePh'));
  value.classList.add('mono', 'mcp-grow');

  host.appendChild(
    detailHeader(isNew ? t('r2.putObject') : params.key, bucket, [
      button(t('common.save'), 'primary sm', async () => {
        const key = keyInput.value.trim();
        if (!key) return;
        const args = { bucket, key, value: value.value, contentType: contentType.value || undefined };
        if (await mutate('cf_r2_object_put', args)) pop();
      }),
    ]),
  );
  host.append(
    field(t('r2.keyLabel'), keyInput),
    field(t('r2.contentTypeLabel'), contentType),
    field(t('r2.valueLabel'), value),
  );

  if (!isNew) {
    value.value = t('common.loading');
    void call('cf_r2_object_get', { bucket, key: params.key })
      .then((r) => {
        const d = detailsOf(r) as { value?: unknown };
        value.value = typeof d.value === 'string' ? d.value : (r.content ?? '');
      })
      .catch(() => {
        value.value = '';
      });
  }
}

export function registerR2Views(): void {
  registerView({ id: 'r2', label: () => t('r2.title'), render: renderBuckets });
  registerView({ id: 'r2-bucket', label: (p) => p.name || 'R2', render: renderBucket });
  registerView({
    id: 'r2-object',
    label: (p) => (p.key ? p.key : t('r2.putObject')),
    render: renderObject,
  });
}
