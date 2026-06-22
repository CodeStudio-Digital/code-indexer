/** Content renderer: a table view per resource (page header + data table with
 *  status pills and inline actions), a logs sub-view, and the project view. */
import {
  button,
  call,
  clear,
  dataTable,
  detailsOf,
  div,
  el,
  errorBox,
  icon,
  jsonPre,
  loadingBox,
  mutate,
  pageHeader,
  rowsOf,
  setChildren,
  type Row,
} from '@mcp/plugin-sdk/ui';
import { actionsFor, colsFor, nameOf, rowKeyFor, str, type ViewCtx } from './columns.js';
import { resource } from './resources.js';
import { openCreate } from './forms.js';
import { renderAssistant } from './chat.js';
import type { Translate } from './i18n.js';

/** Fill a flex column body with a table/state node that grows + has margin. */
function fill(body: HTMLElement, node: HTMLElement): void {
  node.style.flex = '1';
  node.style.margin = '12px';
  setChildren(body, node);
}

export function renderContent(host: HTMLElement, id: string, t: Translate): void {
  clear(host);
  if (!resource(id)) return;
  if (id === 'project') return renderProject(host, t);
  if (id === 'assistant') return renderAssistant(host, t);
  renderTable(host, id, t);
}

function renderTable(host: HTMLElement, id: string, t: Translate): void {
  clear(host);
  const res = resource(id)!;
  let rows: Row[] = [];
  let filter = '';

  const ctx: ViewCtx = {
    t,
    reload: () => renderTable(host, id, t),
    showLogs: (row) => renderLogs(host, id, row, t),
    openCreate: (kind, preset) => openCreate(kind, t, ctx.reload, preset),
  };
  const cols = colsFor(id, t);
  const rowKey = rowKeyFor(id);
  const actions = actionsFor(id, ctx);

  const body = div('pod-body-pane');
  const paint = () => {
    const shown = filter ? rows.filter((r) => JSON.stringify(r).toLowerCase().includes(filter)) : rows;
    fill(body, dataTable<Row>({ columns: cols, rows: shown, rowKey, actions, empty: t('kit.noRows') }));
  };

  host.append(
    pageHeader({
      title: t(`${id}.title`),
      subtitle: t(`${id}.sub`),
      primary: res.create ? { label: t('common.new'), icon: 'plus', onClick: () => ctx.openCreate(res.create!) } : undefined,
      search: { placeholder: t('common.filter'), onInput: (v) => { filter = v.toLowerCase(); paint(); } },
    }),
    body,
  );

  setChildren(body, loadingBox());
  call(res.listTool!, res.listArgs)
    .then((r) => {
      rows = rowsOf(r);
      paint();
    })
    .catch((e) => fill(body, errorBox(e)));
}

function renderLogs(host: HTMLElement, resId: string, row: Row, t: Translate): void {
  clear(host);
  const back = button(`‹ ${t('common.back')}`, 'sm', () => renderTable(host, resId, t));
  const body = div('pod-body-pane');
  host.append(pageHeader({ title: t('common.logs'), subtitle: nameOf(row), actions: [back] }), body);

  setChildren(body, loadingBox());
  call('podman_logs', { container: str(row.id) || str(row.name), tail: 300 })
    .then((r) => fill(body, jsonPre(r.content || '(no output)')))
    .catch((e) => fill(body, errorBox(e)));
}

function renderProject(host: HTMLElement, t: Translate): void {
  clear(host);
  const body = div('pod-body-pane pod-pad');
  host.append(pageHeader({ title: t('project.title'), subtitle: t('project.sub') }), body);

  const result = div('mcp-stack mcp-grow');
  const detect = () => {
    setChildren(result, loadingBox());
    call('podman_detect', {})
      .then((r) => setChildren(result, jsonPre(r.content)))
      .catch((e) => setChildren(result, errorBox(e)));
  };
  const containerize = () => {
    setChildren(result, loadingBox());
    call('podman_containerize', {})
      .then((r) => {
        const d = (detailsOf(r) as { containerfile?: string }) ?? {};
        setChildren(result, el('p', 'mcp-muted', r.content), jsonPre(d.containerfile ?? ''));
      })
      .catch((e) => setChildren(result, errorBox(e)));
  };
  const buildRun = button(t('project.buildRun'), 'primary sm', () => void mutate('podman_project_run', {}));
  buildRun.insertBefore(icon('rocket', 15), buildRun.firstChild);

  const bar = div(
    'mcp-toolbar',
    button(t('project.detect'), 'sm', detect),
    buildRun,
    button(t('project.containerize'), 'sm', containerize),
    button(t('project.composeUp'), 'sm', () => void mutate('podman_compose', { action: 'up', detach: true })),
  );
  body.append(div('mcp-stack mcp-grow', bar, el('p', 'mcp-muted', t('project.desc')), result));
}
