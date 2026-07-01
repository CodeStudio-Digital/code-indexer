/**
 * "Git performance" popover — opt-in accelerators for THIS repo (Tier 4).
 * Two reversible toggles backed by `projectGit.gitOptimizations` /
 * `configureGitOptimizations`: untrackedCache (safe local cache) and fsmonitor
 * (git's built-in file-watch daemon, the biggest `status` win on big repos).
 * Both write `.git/config` and only ever fire from an explicit click.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Gauge, Loader2 } from 'lucide-react';
import type { GitOptimizations } from '@mcp/api-bus';
import { apiCall } from '../../../../../lib/api-client.js';
import { Button } from '../../../../../components/ui/button.js';
import { Switch } from '../../../../../components/ui/switch.js';
import { Popover, PopoverContent, PopoverTrigger } from '../../../../../components/ui/popover.js';
import { toast } from '../../../../../components/ui/prompt-dialog.js';

export function GitPerfPanel({ projectId, repoPath }: { projectId: number; repoPath?: string }) {
  const { t } = useTranslation('workspace');
  const [opt, setOpt] = useState<GitOptimizations | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      setOpt(await apiCall<GitOptimizations>('projectGit.gitOptimizations', { projectId, repoPath }));
    } catch {
      /* leave null — the toggles render disabled until a successful read */
    }
  };

  const apply = async (patch: { untrackedCache?: boolean; fsmonitor?: boolean }) => {
    setBusy(true);
    try {
      setOpt(await apiCall<GitOptimizations>('projectGit.configureGitOptimizations', { projectId, repoPath, ...patch }));
    } catch (err) {
      toast.error(t('git.perf.failed'), { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover onOpenChange={(open) => { if (open && !opt) void load(); }}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5 text-muted-foreground hover:text-foreground"
          aria-label={t('git.perf.title')}
        >
          <Gauge className="h-3 w-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-3 text-[11px]">
        <div className="font-medium text-[12px] mb-0.5">{t('git.perf.title')}</div>
        <p className="text-muted-foreground mb-3 leading-snug">{t('git.perf.intro')}</p>

        <PerfRow
          label={t('git.perf.untrackedCache')}
          desc={t('git.perf.untrackedCacheDesc')}
          checked={!!opt?.untrackedCache}
          disabled={!opt || busy}
          onToggle={(v) => void apply({ untrackedCache: v })}
        />
        <PerfRow
          label={t('git.perf.fsmonitor')}
          desc={opt && !opt.fsmonitorSupported ? t('git.perf.fsmonitorUnsupported') : t('git.perf.fsmonitorDesc')}
          checked={!!opt?.fsmonitor}
          disabled={!opt || busy || !opt.fsmonitorSupported}
          onToggle={(v) => void apply({ fsmonitor: v })}
        />

        {opt && (
          <div className="mt-2 pt-2 border-t text-muted-foreground/70 flex items-center gap-1.5">
            {busy && <Loader2 className="h-3 w-3 animate-spin" />}
            <span>{t('git.perf.version', { version: opt.gitVersion })}</span>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function PerfRow({ label, desc, checked, disabled, onToggle }: {
  label: string;
  desc: string;
  checked: boolean;
  disabled: boolean;
  onToggle: (v: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3 py-1.5">
      <div className="flex-1 min-w-0">
        <div className="text-foreground">{label}</div>
        <div className="text-muted-foreground leading-snug">{desc}</div>
      </div>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onToggle} className="mt-0.5" />
    </label>
  );
}
