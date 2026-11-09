import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { jobStatus, cancelJob } from './api.js';
import { createDatabaseJobStore, type DatabaseUiJob } from './database-job-store.js';

let storage: Storage | undefined;
try { storage = globalThis.localStorage; } catch { /* Browser privacy mode. */ }
const store = createDatabaseJobStore({ jobStatus, cancelJob }, storage);
export function beginUiDatabaseJob(connectionId: string, label: string, kind: DatabaseUiJob['kind'] = 'export') {
  return store.begin(connectionId, label, kind);
}

export function DatabaseJobProgress({ connectionIds }: { connectionIds: string[] }) {
  const jobs = useSyncExternalStore(store.subscribe, store.snapshot);
  const items = jobs.filter(job => connectionIds.some(id => job.connectionId === id || job.connectionId.startsWith(id + '@')));
  const { t } = useTranslation('dbClient');
  if (!items.length) return null;
  return <div className="border-b px-2 py-1 text-xs" aria-live="polite">
    {items.map(job => <div key={job.id} className="my-1 flex items-center gap-2" title={job.id}>
      <span className="min-w-0 flex-1 truncate">{job.label}: {job.completed}{job.total != null ? ` / ${job.total}` : ''} — {t(`jobs.${job.state}`)}</span>
      {job.state === 'running' && <button type="button" className="rounded border px-1" onClick={() => store.cancel(job.id)}>{t('jobs.cancel')}</button>}
    </div>)}
  </div>;
}
