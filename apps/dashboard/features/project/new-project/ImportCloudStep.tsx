/**
 * "Import from cloud" wizard step (P6-C). Lists the cloud project-library
 * pointers (synced `project` docs); picking one clones its git remote and seeds
 * the API workspace so collections/envs come down too. No code is stored in the
 * cloud — only a remote URL + names — so the actual source arrives via `git`.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, FolderGit2 } from 'lucide-react';
import { cloudCall } from '../../../lib/cloud/cloud-client.js';
import { CloudError } from '../../../lib/cloud/cloud-errors.js';
import { planProjectApply, type ProjectPointer } from '../../api-client/sync/project-pointer-core.js';

export function ImportCloudStep({ onPick }: { onPick: (pointer: ProjectPointer) => void }) {
  const { t } = useTranslation('projects');
  const [pointers, setPointers] = useState<ProjectPointer[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const pull = await cloudCall('sync.pull', { kinds: ['project'], sinceVersion: 0 });
        const actions = planProjectApply(pull.documents, () => 0);
        setPointers(actions.filter((a) => !a.deleted && a.pointer?.gitRemote).map((a) => a.pointer as ProjectPointer));
      } catch (e) {
        setError(e instanceof CloudError ? e.message : String(e));
      }
    })();
  }, []);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!pointers) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> {t('wizard.importLoading')}
      </div>
    );
  }
  if (pointers.length === 0) return <p className="py-6 text-sm text-muted-foreground">{t('wizard.importEmpty')}</p>;

  return (
    <div className="max-h-80 space-y-1.5 overflow-auto">
      {pointers.map((p) => (
        <button
          key={p.workspaceId}
          type="button"
          onClick={() => onPick(p)}
          className="flex w-full items-start gap-2 rounded-md border px-3 py-2 text-left transition-colors hover:bg-accent"
        >
          <FolderGit2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{p.name}</div>
            <div className="truncate font-mono text-xs text-muted-foreground">{p.gitRemote}</div>
            {p.description ? <div className="truncate text-xs text-muted-foreground">{p.description}</div> : null}
          </div>
        </button>
      ))}
    </div>
  );
}
