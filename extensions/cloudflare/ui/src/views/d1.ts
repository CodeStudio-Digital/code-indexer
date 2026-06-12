/** D1 list view: databases → drill into d1-db (tables/SQL, see d1-detail). */
import { call, mutate, rowsOf } from '../core/api.js';
import { invalidateRows } from '../core/state.js';
import { push, refresh, registerView } from '../core/router.js';
import { listView } from '../core/widgets.js';
import { mcp } from '../core/mcp.js';
import { t } from '../core/i18n.js';
import { registerD1DetailViews } from './d1-detail.js';

interface DbRow {
  name?: string;
  uuid?: string;
}

export function registerD1Views(): void {
  registerView({
    id: 'd1',
    label: () => t('d1.title'),
    render(host) {
      listView<DbRow>(host, {
        cacheKey: 'd1',
        searchPlaceholder: t('common.filter'),
        load: async () => rowsOf(await call('cf_d1_list')) as DbRow[],
        row: (db) => ({ title: String(db.name ?? db.uuid ?? '?'), meta: String(db.uuid ?? '') }),
        onPick: (db) =>
          push('d1-db', { database: String(db.name ?? db.uuid ?? ''), uuid: String(db.uuid ?? '') }),
        onCreate: async () => {
          const name = await mcp.ui.prompt({
            title: t('d1.create'),
            placeholder: t('d1.namePh'),
          });
          if (!name?.trim()) return;
          const r = await mutate('cf_d1_create', { name: name.trim() });
          if (r) {
            invalidateRows('d1');
            refresh();
          }
        },
      });
    },
  });
  registerD1DetailViews();
}
