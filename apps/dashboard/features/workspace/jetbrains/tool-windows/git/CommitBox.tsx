/**
 * Inline commit box — the IDE's primary commit surface, pinned at the
 * bottom of the Git tool window's Changes tab (replaces the old modal
 * dialog there). Mirrors the collapsible-section pattern of the file
 * groups above it: a chevron header toggles the body, so the user can
 * minimize the box and give the file list back its vertical space.
 *
 * Three affordances beyond a plain textarea, matching the JetBrains
 * commit panel the user asked for:
 *   - Sparkles → generate a Conventional-Commits message from the staged
 *     diff via the "IA Geral" provider (`projectGit.aiCommitMessage`).
 *   - Amend    → rewrite the last commit instead of creating a new one.
 *   - Commit and Push → commit, then push (publishing the branch with
 *     `-u` when it doesn't track a remote yet).
 *
 * Dumb-ish: the parent owns the git status reload; we call `onCommitted`
 * after a successful commit so the panel re-syncs.
 */
import { useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Sparkles, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { apiCall } from '../../../../../lib/api-client.js';
import { Button } from '../../../../../components/ui/button.js';
import { toast } from '../../../../../components/ui/prompt-dialog.js';

interface CommitBoxProps {
  projectId: number;
  /** Selected git root (submodule / nested repo); undefined = main repo. */
  repoPath?: string;
  /** Staged file count — gates the Commit button + AI generate. */
  stagedCount: number;
  /** Current branch upstream, or null when it doesn't track a remote yet. */
  upstream: string | null;
  /** Called after a successful commit so the parent refreshes git status. */
  onCommitted: () => void;
}

export function CommitBox({ projectId, repoPath, stagedCount, upstream, onCommitted }: CommitBoxProps) {
  const { t } = useTranslation('workspace');
  const [open, setOpen] = useState(true);
  const [message, setMessage] = useState('');
  const [amend, setAmend] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [generating, setGenerating] = useState(false);

  // The commit handler always reads the message from stdin (`-F -`), so a
  // message is required even when amending. You also need something to
  // commit: either staged changes, or `--amend` (reword the last commit).
  const canCommit = !committing && !!message.trim() && (amend || stagedCount > 0);

  const generate = async () => {
    if (stagedCount === 0 || generating) return;
    setGenerating(true);
    try {
      const r = await apiCall<{ message: string }>('projectGit.aiCommitMessage', { projectId, repoPath });
      if (r.message) setMessage(r.message);
    } catch (e) {
      const err = e as Error & { status?: number };
      toast.error(err.status === 412 ? t('git.aiNotConfigured') : t('git.generateFailed'), {
        description: err.message,
      });
    } finally {
      setGenerating(false);
    }
  };

  const commit = async (push: boolean) => {
    if (!canCommit) return;
    setCommitting(true);
    try {
      await apiCall<{ sha: string }>('projectGit.commit', {
        projectId,
        repoPath,
        message: message.trim(),
        amend,
      });
      if (push) {
        const res = await apiCall<{ ok: boolean; stderr: string }>('projectGit.push', {
          projectId,
          repoPath,
          setUpstream: !upstream,
        });
        // The commit already landed — surface a push failure without
        // losing it, so the user can retry the push from the status bar.
        if (!res.ok) {
          toast.error(t('git.pushFailed'), { description: res.stderr });
        }
      }
      setMessage('');
      setAmend(false);
      onCommitted();
    } catch (e) {
      toast.error(t('git.commitFailed'), {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setCommitting(false);
    }
  };

  return (
    <div className="shrink-0 border-t bg-card/40">
      <div className="flex items-center gap-1 px-2.5 py-1">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1 text-[10px] uppercase tracking-[0.08em] text-muted-foreground hover:text-foreground"
        >
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          <span className="font-semibold">{t('git.commitSection')}</span>
        </button>
        {stagedCount > 0 && (
          <span className="ml-auto text-[10px] text-muted-foreground">
            {t('git.staged', { count: stagedCount })}
          </span>
        )}
      </div>

      {open && (
        <div className="px-2.5 pb-2 space-y-1.5">
          <div className="relative">
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={t('git.commitMessagePlaceholder')}
              disabled={committing}
              className="w-full min-h-[64px] max-h-[200px] rounded-md border bg-card px-3 py-2 pr-8 text-[12px] focus:outline-none focus:ring-2 focus:ring-ring/40 resize-y"
            />
            <button
              type="button"
              onClick={() => void generate()}
              disabled={stagedCount === 0 || generating || committing}
              title={t('git.generateWithAi')}
              aria-label={t('git.generateWithAi')}
              className="absolute right-1.5 top-1.5 h-6 w-6 grid place-items-center rounded-sm text-muted-foreground hover:text-primary hover:bg-muted disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
            >
              {generating ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" />
              )}
            </button>
          </div>

          <label className="flex items-center gap-1.5 w-fit text-[11px] text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={amend}
              onChange={(e) => setAmend(e.target.checked)}
              disabled={committing}
              className="h-3 w-3 accent-primary"
            />
            {t('git.amend')}
          </label>

          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              onClick={() => void commit(false)}
              disabled={!canCommit}
              className="h-7 flex-1 text-[11.5px]"
            >
              {committing && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
              {t('git.commit')}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void commit(true)}
              disabled={!canCommit}
              title={t('git.commitAndPush')}
              className="h-7 text-[11.5px]"
            >
              <Upload className="h-3 w-3 mr-1" />
              {t('git.commitAndPush')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
