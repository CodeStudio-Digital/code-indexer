/**
 * Merge-in-progress banner — the amber strip under the Git tool window's
 * branch header when a cherry-pick / merge / revert / rebase is mid-flight
 * and conflicted. Mirrors WebStorm: states what's happening + Resolve
 * (Continue) and Abort. Continue is gated until every file is resolved.
 */

import { useState } from 'react';
import { AlertTriangle, Check, Loader2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { GitMergeState, GitRunResult } from '@mcp/api-bus';
import { apiCall } from '../../../../../../lib/api-client.js';
import { Button } from '../../../../../../components/ui/button.js';
import { confirm, toast } from '../../../../../../components/ui/prompt-dialog.js';

const VERB_KEY: Record<NonNullable<GitMergeState['kind']>, string> = {
  'cherry-pick': 'git.conflict.banner.cherryPick',
  merge: 'git.conflict.banner.merge',
  revert: 'git.conflict.banner.revert',
  rebase: 'git.conflict.banner.rebase',
};

interface MergeBannerProps {
  projectId: number;
  state: GitMergeState;
  onMutated: () => void;
}

export function MergeBanner({ projectId, state, onMutated }: MergeBannerProps) {
  const { t } = useTranslation('workspace');
  const [busy, setBusy] = useState<null | 'continue' | 'abort'>(null);
  if (!state.kind) return null;
  const remaining = state.conflictedFiles.length;

  const onContinue = async () => {
    setBusy('continue');
    try {
      const r = await apiCall<GitRunResult>('projectGit.mergeContinue', { projectId });
      if (!r.ok) {
        toast.error(t('git.conflict.continueFailed'), {
          description: r.stderr.trim().slice(0, 300) || r.stdout.trim().slice(0, 300),
        });
      }
      onMutated();
    } catch (e) {
      toast.error(t('git.conflict.continueFailed'), { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const onAbort = async () => {
    const ok = await confirm({
      title: t('git.conflict.abortConfirmTitle'),
      description: t('git.conflict.abortConfirmBody'),
      confirmLabel: t('git.conflict.abort'),
      tone: 'destructive',
    });
    if (!ok) return;
    setBusy('abort');
    try {
      const r = await apiCall<GitRunResult>('projectGit.mergeAbort', { projectId });
      if (!r.ok) toast.error(t('git.conflict.abortFailed'), { description: r.stderr.trim().slice(0, 300) });
      onMutated();
    } catch (e) {
      toast.error(t('git.conflict.abortFailed'), { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="shrink-0 flex items-center gap-2 px-2.5 py-1.5 border-b bg-amber-500/10 text-[11px]">
      <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
      <span className="truncate">
        <span className="font-medium">{t(VERB_KEY[state.kind])}</span>{' '}
        <span className="font-mono">{state.theirsLabel}</span>
        {' → '}
        <span className="font-mono">{state.oursLabel}</span>
        {' · '}
        {t('git.conflict.count', { count: remaining })}
      </span>
      <div className="ml-auto flex items-center gap-1 shrink-0">
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[11px] gap-1 text-emerald-500 hover:text-emerald-400 disabled:opacity-40"
          disabled={remaining > 0 || busy !== null}
          onClick={() => void onContinue()}
          title={remaining > 0 ? t('git.conflict.continueBlocked') : t('git.conflict.continue')}
        >
          {busy === 'continue' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
          {t('git.conflict.continue')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[11px] gap-1 text-muted-foreground hover:text-destructive"
          disabled={busy !== null}
          onClick={() => void onAbort()}
        >
          {busy === 'abort' ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
          {t('git.conflict.abort')}
        </Button>
      </div>
    </div>
  );
}
