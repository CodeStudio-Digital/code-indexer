/**
 * Cloud-sync dialog for the API client: a manual "Sync now" for environments
 * (structure-only — secrets stay on this device), the shareable workspace id, and
 * a field to JOIN another machine's workspace. Entitlement is enforced server-side
 * (`sync`); a free/anon caller gets a typed error surfaced inline.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, Copy, Check, Loader2, Link2, UploadCloud } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog.js';
import { Button } from '../../components/ui/button.js';
import { confirm } from '../../components/ui/prompt-dialog.js';
import { UpgradeNotice } from '../../components/UpgradeNotice.js';
import { apiCall } from '../../lib/api-client.js';
import { cloudCall } from '../../lib/cloud/cloud-client.js';
import { CloudError } from '../../lib/cloud/cloud-errors.js';
import { useEntitlements } from '../account/useEntitlements.js';
import { useApiSync } from './sync/use-api-sync.js';
import { projectPointerToPush } from './sync/project-pointer-core.js';

interface Props {
  projectId: number;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

export function CloudSyncDialog({ projectId, open, onOpenChange }: Props) {
  const { t } = useTranslation('apiClient');
  const { has } = useEntitlements();
  const { workspaceId, busy, error, last, sync, linkWorkspace } = useApiSync(projectId);
  const [copied, setCopied] = useState(false);
  const [joinId, setJoinId] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [publishMsg, setPublishMsg] = useState<string | null>(null);

  // Publish a clone-able project pointer to the cloud library (P6-C). The pointer
  // = repo remote + names, keyed on this project's workspaceId; no code/secrets.
  const publishPointer = async () => {
    setPublishing(true);
    setPublishMsg(null);
    try {
      const proj = await apiCall<{ name: string; git_remote?: string | null; default_branch?: string | null }>('projects.get', { id: projectId });
      let gitRemote = proj.git_remote ?? null;
      let defaultBranch = proj.default_branch ?? null;
      if (!gitRemote) {
        const detected = await apiCall<{ gitRemote: string | null; defaultBranch: string | null }>('projectGit.detectRemote', { projectId });
        gitRemote = detected.gitRemote;
        defaultBranch = defaultBranch ?? detected.defaultBranch;
      }
      if (!gitRemote) {
        setPublishMsg(t('cloudSync.noRemote'));
        return;
      }
      const item = projectPointerToPush({ name: proj.name, gitRemote, defaultBranch, workspaceId }, 0, Date.now());
      await cloudCall('sync.push', { documents: [item] });
      setPublishMsg(t('cloudSync.published'));
    } catch (e) {
      setPublishMsg(e instanceof CloudError ? e.message : String(e));
    } finally {
      setPublishing(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(workspaceId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — non-fatal */
    }
  };

  const join = async () => {
    if (!joinId.trim()) return;
    if (await confirm({ title: t('cloudSync.linkConfirmTitle'), description: t('cloudSync.linkConfirmBody'), tone: 'destructive' })) {
      linkWorkspace(joinId);
      setJoinId('');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><RefreshCw className="h-4 w-4" /> {t('cloudSync.title')}</DialogTitle>
        </DialogHeader>

        <p className="text-xs text-muted-foreground">{t('cloudSync.subtitle')}</p>
        {!has('sync') ? <UpgradeNotice message={t('cloudSync.upgradeMsg')} cta={t('cloudSync.upgradeCta')} /> : null}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}

        <div className="flex items-center gap-2">
          <Button size="sm" disabled={busy} onClick={() => void sync()}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} {busy ? t('cloudSync.syncing') : t('cloudSync.syncNow')}
          </Button>
          {last ? (
            <span className="text-[11px] text-muted-foreground">
              {t('cloudSync.lastResult', { pushed: last.pushed, applied: last.pulledApplied, conflicts: last.conflicts })}
            </span>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <div className="text-xs font-medium text-muted-foreground">{t('cloudSync.workspace')}</div>
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 truncate text-[11px] font-mono bg-background rounded px-2 py-1 border">{workspaceId}</code>
            <Button size="icon" variant="ghost" className="h-7 w-7" title={t('cloudSync.copy')} onClick={() => void copy()}>
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">{t('cloudSync.workspaceHint')}</p>
        </div>

        {has('sync') ? (
          <div className="space-y-1.5">
            <div className="text-xs font-medium text-muted-foreground">{t('cloudSync.publishTitle')}</div>
            <Button size="sm" variant="outline" disabled={publishing} onClick={() => void publishPointer()}>
              {publishing ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <UploadCloud className="h-3.5 w-3.5 mr-1" />}
              {publishing ? t('cloudSync.publishing') : t('cloudSync.publishBtn')}
            </Button>
            <p className="text-[11px] text-muted-foreground">{t('cloudSync.publishHint')}</p>
            {publishMsg ? <p className="text-[11px] text-muted-foreground">{publishMsg}</p> : null}
          </div>
        ) : null}

        <div className="space-y-1.5">
          <div className="text-xs font-medium text-muted-foreground">{t('cloudSync.linkLabel')}</div>
          <div className="flex items-center gap-2">
            <input
              className="flex-1 min-w-0 text-xs bg-background border rounded px-2 py-1.5 font-mono"
              placeholder={t('cloudSync.linkPlaceholder')}
              value={joinId}
              onChange={(e) => setJoinId(e.target.value)}
            />
            <Button size="sm" variant="outline" disabled={!joinId.trim()} onClick={() => void join()}>
              <Link2 className="h-3.5 w-3.5 mr-1" /> {t('cloudSync.link')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
