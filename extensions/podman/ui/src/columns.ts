/** Per-resource table columns, row keys and inline row actions. Status cells
 *  render as pills; actions map to the same podman tools the old panel used. */
import { mutate, status, type Column, type Row, type RowAction } from '@mcp/plugin-sdk/ui';
import type { CreateKind } from './resources.js';
import type { Translate } from './i18n.js';

export interface ViewCtx {
  t: Translate;
  reload: () => void;
  showLogs: (row: Row) => void;
  openCreate: (kind: CreateKind, presetImage?: string) => void;
}

const str = (v: unknown): string => (v == null ? '' : String(v));
const short = (v: unknown): string => str(v).slice(0, 12);

function nameOf(r: Row): string {
  const names = r.names as string[] | undefined;
  return (names && names[0]) || short(r.id) || '—';
}

function stateKind(state: string): 'ok' | 'warn' | 'err' | 'muted' {
  const s = state.toLowerCase();
  if (s.includes('run') || s.includes('up')) return 'ok';
  if (s.includes('paus')) return 'warn';
  if (s.includes('dead') || s.includes('error')) return 'err';
  return 'muted';
}

const pill = (value: string) => status(stateKind(value), (value || '—').toUpperCase());

function sizeMb(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? `${(n / 1048576).toFixed(0)} MB` : '—';
}

export function rowKeyFor(id: string): (r: Row) => string {
  if (id === 'images') return (r) => str(r.reference);
  if (id === 'volumes' || id === 'networks') return (r) => str(r.name);
  return (r) => str(r.id);
}

export function colsFor(id: string, t: Translate): Column<Row>[] {
  switch (id) {
    case 'containers':
      return [
        { header: t('col.name'), cell: nameOf },
        { header: t('col.image'), cell: (r) => str(r.image), mono: true },
        { header: t('col.status'), cell: (r) => pill(str(r.state)) },
        { header: t('col.ports'), cell: (r) => str(r.ports) || '—' },
        { header: t('col.uptime'), cell: (r) => str(r.status) || '—' },
      ];
    case 'images':
      return [
        { header: t('col.repo'), cell: (r) => str(r.repository) || str(r.reference) },
        { header: t('col.tag'), cell: (r) => str(r.tag) || '—' },
        { header: t('col.id'), cell: (r) => short(r.id), mono: true },
        { header: t('col.size'), cell: (r) => sizeMb(r.size), num: true },
      ];
    case 'volumes':
      return [
        { header: t('col.name'), cell: (r) => str(r.name) },
        { header: t('col.driver'), cell: (r) => str(r.driver) || '—' },
        { header: t('col.mountpoint'), cell: (r) => str(r.mountpoint) || '—', mono: true },
      ];
    case 'networks':
      return [
        { header: t('col.name'), cell: (r) => str(r.name) },
        { header: t('col.driver'), cell: (r) => str(r.driver) || '—' },
        { header: t('col.id'), cell: (r) => short(r.id), mono: true },
      ];
    case 'pods':
      return [
        { header: t('col.name'), cell: (r) => str(r.name) },
        { header: t('col.status'), cell: (r) => pill(str(r.status)) },
        { header: t('col.containers'), cell: (r) => str(r.containers), num: true },
      ];
    default:
      return [];
  }
}

export function actionsFor(id: string, ctx: ViewCtx): RowAction<Row>[] {
  const { t, reload } = ctx;
  const run = (tool: string, args: Record<string, unknown>, danger?: string) =>
    void mutate(tool, args, danger ? { danger } : undefined).then((r) => {
      if (r) reload();
    });
  const rm = (tool: string, args: Record<string, unknown>, name: string): RowAction<Row> => ({
    icon: 'trash-2',
    title: t('common.remove'),
    danger: true,
    onClick: () => run(tool, { ...args, force: true }, t('confirm.remove', { name })),
  });

  switch (id) {
    case 'containers':
      return [
        { icon: 'play', title: t('common.start'), onClick: (r) => run('podman_start', { container: str(r.id) }) },
        { icon: 'square', title: t('common.stop'), onClick: (r) => run('podman_stop', { container: str(r.id) }) },
        { icon: 'scroll-text', title: t('common.logs'), onClick: (r) => ctx.showLogs(r) },
        { ...rm('podman_rm', {}, ''), onClick: (r) => run('podman_rm', { container: str(r.id), force: true }, t('confirm.remove', { name: nameOf(r) })) },
      ];
    case 'images':
      return [
        { icon: 'play', title: t('common.run'), onClick: (r) => ctx.openCreate('run', str(r.reference)) },
        { ...rm('podman_rmi', {}, ''), onClick: (r) => run('podman_rmi', { reference: str(r.reference), force: true }, t('confirm.remove', { name: str(r.reference) })) },
      ];
    case 'volumes':
      return [{ ...rm('podman_volume_rm', {}, ''), onClick: (r) => run('podman_volume_rm', { name: str(r.name), force: true }, t('confirm.remove', { name: str(r.name) })) }];
    case 'networks':
      return [{ ...rm('podman_network_rm', {}, ''), onClick: (r) => run('podman_network_rm', { name: str(r.name), force: true }, t('confirm.remove', { name: str(r.name) })) }];
    case 'pods':
      return [
        { icon: 'play', title: t('common.start'), onClick: (r) => run('podman_pod_start', { pod: str(r.id) }) },
        { icon: 'square', title: t('common.stop'), onClick: (r) => run('podman_pod_stop', { pod: str(r.id) }) },
        { ...rm('podman_pod_rm', {}, ''), onClick: (r) => run('podman_pod_rm', { pod: str(r.id), force: true }, t('confirm.remove', { name: str(r.name) })) },
      ];
    default:
      return [];
  }
}

export { nameOf, str };
