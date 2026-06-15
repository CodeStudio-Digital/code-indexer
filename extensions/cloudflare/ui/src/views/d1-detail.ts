/**
 * D1 drill-in views:
 *  - d1-db    {database, uuid}: header actions + Tables | SQL tabs
 *  - d1-table {database, table}: Rows (paged, insert/edit/delete) | Schema
 */
import { button, clear, div, el, setChildren, textarea } from '../core/dom.js';
import { call, detailsOf, mutate, parseJsonOr, rowsOf, type Row } from '../core/api.js';
import { invalidateRows } from '../core/state.js';
import { home, push, registerView } from '../core/router.js';
import { dataTable, detailHeader, errorBox, jsonPre, loadingBox, tabsBar } from '../core/widgets.js';
import { mcp } from '../core/mcp.js';
import { t } from '../core/i18n.js';

const PAGE = 50;

/** Prompt for a JSON object (host dialog), null on cancel/bad JSON. */
async function promptJson(title: string): Promise<Record<string, unknown> | null> {
  const text = await mcp.ui.prompt({ title, placeholder: t('d1.rowJsonPh') });
  if (text == null) return null;
  const parsed = parseJsonOr(text, {});
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
}

function renderDb(host: HTMLElement, params: Record<string, string>): void {
  const database = params.database;
  let tab = 'tables';
  host.appendChild(
    detailHeader(database, params.uuid ?? '', [
      button(t('d1.export'), 'sm', () => void mutate('cf_d1_export', { database })),
      button(t('d1.bookmark'), 'sm', async () => {
        try {
          const r = await call('cf_d1_time_travel_bookmark', { database });
          setChildren(body, jsonPre(detailsOf(r)));
        } catch (e) {
          setChildren(body, errorBox(e));
        }
      }),
      button(t('common.delete'), 'danger sm', async () => {
        const r = await mutate('cf_d1_delete', { database: params.uuid || database }, {
          danger: t('d1.deleteTitle'),
          detail: database,
        });
        if (r) {
          invalidateRows('d1');
          home();
        }
      }),
    ]),
  );
  const body = div('mcp-stack mcp-grow');
  const paintTabs = () => {
    setChildren(
      tabsHost,
      tabsBar(
        [
          { id: 'tables', label: t('d1.tables') },
          { id: 'sql', label: 'SQL' },
        ],
        tab,
        (id) => {
          tab = id;
          paintTabs();
          draw();
        },
      ),
    );
  };
  const tabsHost = div();
  host.append(tabsHost, body);

  const draw = () => {
    clear(body);
    if (tab === 'tables') drawTables();
    else drawSql();
  };
  const drawTables = async () => {
    setChildren(body, loadingBox());
    try {
      const r = await call('cf_d1_tables', { database });
      setChildren(
        body,
        dataTable(rowsOf(r), (row) => [
          button(t('d1.rows'), 'sm', () =>
            push('d1-table', { database, table: String(row.name) }),
          ),
        ]),
      );
    } catch (e) {
      setChildren(body, errorBox(e));
    }
  };
  const drawSql = () => {
    const sql = textarea('SELECT …', "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY name");
    const result = div('mcp-grow');
    const run = async (tool: string) => {
      setChildren(result, loadingBox(t('d1.runningSql')));
      try {
        const r = await call(tool, { database, sql: sql.value });
        setChildren(result, dataTable(rowsOf(r)));
      } catch (e) {
        setChildren(result, errorBox(e));
      }
    };
    const bar = div('mcp-toolbar',
      button(t('d1.runRead'), 'primary sm', () => void run('cf_d1_query')),
      button(t('d1.runWrite'), 'danger sm', async () => {
        const r = await mutate('cf_d1_execute', { database, sql: sql.value }, {
          danger: t('d1.runWriteTitle'),
          detail: sql.value,
        });
        if (r) void run('cf_d1_query');
      }),
    );
    body.append(sql, bar, result);
  };
  paintTabs();
  draw();
}

function renderTable(host: HTMLElement, params: Record<string, string>): void {
  const { database, table } = params;
  let tab = 'rows';
  let offset = 0;
  const body = div('mcp-stack mcp-grow');
  const tabsHost = div();
  host.append(
    detailHeader(table, database, [
      button(t('d1.insertRow'), 'primary sm', async () => {
        const data = await promptJson(t('d1.insertRowTitle', { name: table }));
        if (data && (await mutate('cf_d1_row_insert', { database, table, data }))) draw();
      }),
    ]),
    tabsHost,
    body,
  );
  const paintTabs = () =>
    setChildren(
      tabsHost,
      tabsBar(
        [
          { id: 'rows', label: t('d1.rows') },
          { id: 'schema', label: t('d1.schema') },
        ],
        tab,
        (id) => {
          tab = id;
          paintTabs();
          draw();
        },
      ),
    );

  const rowActions = (row: Row): HTMLElement[] => [
    button(t('common.edit'), 'sm', async () => {
      const data = await promptJson(t('d1.updateRowTitle', { id: String(row.__rowid) }));
      if (data && (await mutate('cf_d1_row_update', { database, table, rowid: row.__rowid, data })))
        draw();
    }),
    button(t('common.delete'), 'danger sm', async () => {
      const r = await mutate('cf_d1_row_delete', { database, table, rowid: row.__rowid }, {
        danger: t('d1.deleteRowTitle'),
      });
      if (r) draw();
    }),
  ];

  const draw = async () => {
    setChildren(body, loadingBox());
    try {
      if (tab === 'schema') {
        const r = await call('cf_d1_table_schema', { database, table });
        setChildren(body, jsonPre(detailsOf(r)));
        return;
      }
      const r = await call('cf_d1_rows', { database, table, limit: PAGE, offset });
      const pager = div('mcp-toolbar',
        button(t('common.prev'), 'sm', () => {
          offset = Math.max(0, offset - PAGE);
          void draw();
        }),
        el('span', 'mcp-row-meta', `${offset + 1}–${offset + rowsOf(r).length}`),
        button(t('common.next'), 'sm', () => {
          offset += PAGE;
          void draw();
        }),
      );
      setChildren(body, pager, dataTable(rowsOf(r), rowActions));
    } catch (e) {
      setChildren(body, errorBox(e));
    }
  };
  paintTabs();
  void draw();
}

export function registerD1DetailViews(): void {
  registerView({ id: 'd1-db', label: (p) => p.database || 'D1', render: renderDb });
  registerView({ id: 'd1-table', label: (p) => p.table || t('d1.tables'), render: renderTable });
}
