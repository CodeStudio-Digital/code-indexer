/**
 * Declarative configs for the compact (data-driven) domains — Queues,
 * Workers, Pages, Vectorize, Durable Objects, Hyperdrive, Workers AI.
 * `generic-domain.ts` renders them: list → item (JSON + actions). The four
 * flagship domains (D1/KV/R2/DNS) have dedicated views instead.
 */
import type { Row } from '../core/api.js';

export interface DomainAction {
  labelKey: string;
  tool: string;
  args(row: Row): Record<string, unknown>;
  /** i18n key for the confirm dialog title — marks the action destructive. */
  dangerKey?: string;
  /** Renders the result (rows table / JSON) in the item body. */
  showsResult?: boolean;
}

export interface DomainConfig {
  id: string;
  titleKey: string;
  subKey: string;
  listTool: string;
  key(row: Row): string;
  title(row: Row): string;
  meta(row: Row): string;
  /** Action that loads the item's default body content on open. */
  openWith?: DomainAction;
  actions: DomainAction[];
  /** Invalidate + refresh the list after this action succeeds. */
  reloadsList?: string[];
}

const str = (v: unknown): string => (v == null ? '' : String(v));

export const DOMAIN_CONFIGS: Record<string, DomainConfig> = {
  queues: {
    id: 'queues',
    titleKey: 'domain.queues',
    subKey: 'domain.queuesSub',
    listTool: 'cf_queues_list',
    key: (r) => str(r.queue_id ?? r.name),
    title: (r) => str(r.queue_name ?? r.name ?? r.queue_id),
    meta: (r) => str(r.queue_id ?? ''),
    openWith: { labelKey: 'domain.metrics', tool: 'cf_queue_metrics', args: (r) => ({ queueId: str(r.queue_id) }), showsResult: true },
    actions: [
      { labelKey: 'domain.metrics', tool: 'cf_queue_metrics', args: (r) => ({ queueId: str(r.queue_id) }), showsResult: true },
      { labelKey: 'domain.consumers', tool: 'cf_queue_consumers', args: (r) => ({ queueId: str(r.queue_id) }), showsResult: true },
      { labelKey: 'domain.purge', tool: 'cf_queue_purge', args: (r) => ({ queueId: str(r.queue_id) }), dangerKey: 'domain.purgeTitle' },
      { labelKey: 'common.delete', tool: 'cf_queue_delete', args: (r) => ({ queueId: str(r.queue_id) }), dangerKey: 'domain.deleteQueueTitle' },
    ],
    reloadsList: ['cf_queue_delete'],
  },
  workers: {
    id: 'workers',
    titleKey: 'domain.workers',
    subKey: 'domain.workersSub',
    listTool: 'cf_workers_list',
    key: (r) => str(r.id ?? r.name ?? r.script_name),
    title: (r) => str(r.id ?? r.name ?? r.script_name),
    meta: (r) => str(r.modified_on ?? r.created_on ?? ''),
    openWith: { labelKey: 'domain.deployments', tool: 'cf_deployments', args: (r) => ({ script: str(r.id ?? r.name) }), showsResult: true },
    actions: [
      { labelKey: 'domain.deployments', tool: 'cf_deployments', args: (r) => ({ script: str(r.id ?? r.name) }), showsResult: true },
      { labelKey: 'domain.settings', tool: 'cf_worker_settings', args: (r) => ({ script: str(r.id ?? r.name) }), showsResult: true },
      { labelKey: 'domain.secrets', tool: 'cf_secrets_list', args: (r) => ({ script: str(r.id ?? r.name) }), showsResult: true },
      { labelKey: 'domain.cron', tool: 'cf_cron_list', args: (r) => ({ script: str(r.id ?? r.name) }), showsResult: true },
      { labelKey: 'common.delete', tool: 'cf_worker_delete', args: (r) => ({ script: str(r.id ?? r.name) }), dangerKey: 'domain.deleteWorkerTitle' },
    ],
    reloadsList: ['cf_worker_delete'],
  },
  pages: {
    id: 'pages',
    titleKey: 'domain.pages',
    subKey: 'domain.pagesSub',
    listTool: 'cf_pages_list',
    key: (r) => str(r.name),
    title: (r) => str(r.name),
    meta: (r) => str(r.subdomain ?? ''),
    openWith: { labelKey: 'domain.deployments', tool: 'cf_pages_deployments', args: (r) => ({ project: str(r.name) }), showsResult: true },
    actions: [
      { labelKey: 'domain.deployments', tool: 'cf_pages_deployments', args: (r) => ({ project: str(r.name) }), showsResult: true },
      { labelKey: 'common.delete', tool: 'cf_pages_delete', args: (r) => ({ project: str(r.name) }), dangerKey: 'domain.deletePagesTitle' },
    ],
    reloadsList: ['cf_pages_delete'],
  },
  vectorize: {
    id: 'vectorize',
    titleKey: 'domain.vectorize',
    subKey: 'domain.vectorizeSub',
    listTool: 'cf_vectorize_list',
    key: (r) => str(r.name),
    title: (r) => str(r.name),
    meta: (r) => {
      const cfg = r.config as { dimensions?: number; metric?: string } | undefined;
      return cfg ? `dim ${cfg.dimensions ?? '?'} · ${cfg.metric ?? ''}` : '';
    },
    openWith: { labelKey: 'domain.info', tool: 'cf_vectorize_info', args: (r) => ({ name: str(r.name) }), showsResult: true },
    actions: [
      { labelKey: 'domain.info', tool: 'cf_vectorize_info', args: (r) => ({ name: str(r.name) }), showsResult: true },
      { labelKey: 'domain.vectors', tool: 'cf_vectorize_vectors_list', args: (r) => ({ name: str(r.name), limit: 50 }), showsResult: true },
      { labelKey: 'common.delete', tool: 'cf_vectorize_delete', args: (r) => ({ name: str(r.name) }), dangerKey: 'domain.deleteIndexTitle' },
    ],
    reloadsList: ['cf_vectorize_delete'],
  },
  do: {
    id: 'do',
    titleKey: 'domain.do',
    subKey: 'domain.doSub',
    listTool: 'cf_do_namespaces',
    key: (r) => str(r.id),
    title: (r) => str(r.name),
    meta: (r) => `${str(r.class ?? '')} ${str(r.id)}`.trim(),
    openWith: { labelKey: 'domain.objects', tool: 'cf_do_objects', args: (r) => ({ namespaceId: str(r.id) }), showsResult: true },
    actions: [
      { labelKey: 'domain.objects', tool: 'cf_do_objects', args: (r) => ({ namespaceId: str(r.id) }), showsResult: true },
    ],
  },
  hyperdrive: {
    id: 'hyperdrive',
    titleKey: 'domain.hyperdrive',
    subKey: 'domain.hyperdriveSub',
    listTool: 'cf_hyperdrive_list',
    key: (r) => str(r.id),
    title: (r) => str(r.name ?? r.id),
    meta: (r) => str(r.id),
    openWith: { labelKey: 'domain.info', tool: 'cf_hyperdrive_get', args: (r) => ({ configId: str(r.id) }), showsResult: true },
    actions: [
      { labelKey: 'domain.info', tool: 'cf_hyperdrive_get', args: (r) => ({ configId: str(r.id) }), showsResult: true },
      { labelKey: 'common.delete', tool: 'cf_hyperdrive_delete', args: (r) => ({ configId: str(r.id) }), dangerKey: 'domain.deleteHyperdriveTitle' },
    ],
    reloadsList: ['cf_hyperdrive_delete'],
  },
  ai: {
    id: 'ai',
    titleKey: 'domain.ai',
    subKey: 'domain.aiSub',
    listTool: 'cf_ai_models',
    key: (r) => str(r.name ?? r.id),
    title: (r) => str(r.name ?? r.id),
    meta: (r) => str((r.task as { name?: string } | undefined)?.name ?? r.description ?? ''),
    actions: [],
  },
};
