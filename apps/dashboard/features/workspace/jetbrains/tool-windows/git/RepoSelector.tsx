/**
 * Repo selector for the Git tool window — a compact dropdown listing every git
 * root inside the project (main + submodules + nested repos) so the user can
 * switch which one the window acts on. Only rendered when a project actually has
 * more than one repo; single-repo projects never see it. Writes the choice to
 * `useGitActiveRepo`; `GitWindow` threads the selection down as `repoPath`.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Check, ChevronsUpDown, FolderGit2, GitBranch } from 'lucide-react';
import type { GitRepoRef } from '@mcp/api-bus';
import { cn } from '../../../../../lib/utils.js';
import { Popover, PopoverContent, PopoverTrigger } from '../../../../../components/ui/popover.js';
import { useGitActiveRepo } from '../../../../../state/git-active-repo.js';

interface RepoSelectorProps {
  projectId: number;
  repos: GitRepoRef[];
  /** Effective selected repo abs path (undefined = main). */
  selected: string | undefined;
}

function kindIcon(kind: GitRepoRef['kind']) {
  if (kind === 'submodule') return Box;
  if (kind === 'nested') return FolderGit2;
  return GitBranch;
}

export function RepoSelector({ projectId, repos, selected }: RepoSelectorProps) {
  const { t } = useTranslation('workspace');
  const [open, setOpen] = useState(false);
  const setRepo = useGitActiveRepo((s) => s.setRepo);

  const main = repos.find((r) => r.kind === 'main');
  const active = (selected && repos.find((r) => r.absPath === selected)) || main || repos[0];
  const ActiveIcon = active ? kindIcon(active.kind) : GitBranch;

  const label = (r: GitRepoRef) =>
    r.kind === 'main' ? t('git.repos.main') : r.projectRelPrefix || r.name;

  const pick = (r: GitRepoRef) => {
    if (!r.initialized) return;
    setRepo(projectId, r.kind === 'main' ? undefined : r.absPath);
    setOpen(false);
  };

  return (
    <div className="shrink-0 px-2.5 py-1 border-b flex items-center gap-1.5">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-1.5 min-w-0 flex-1 rounded px-1 -mx-1 py-0.5 text-[11px] hover:bg-muted/40 transition-colors"
            title={t('git.repos.select')}
          >
            <ActiveIcon className="h-3 w-3 text-muted-foreground shrink-0" />
            <span className="truncate font-medium">{active ? label(active) : t('git.repos.main')}</span>
            <span className="ml-auto text-[9px] uppercase tracking-wide text-muted-foreground/60 shrink-0">
              {t(`git.repos.kind.${active?.kind ?? 'main'}` as const)}
            </span>
            <ChevronsUpDown className="h-3 w-3 text-muted-foreground/60 shrink-0" />
          </button>
        </PopoverTrigger>
        <PopoverContent side="bottom" align="start" className="p-1 w-[280px]">
          <div className="text-[9.5px] uppercase tracking-[0.08em] text-muted-foreground px-2 py-1">
            {t('git.repos.label', { count: repos.length })}
          </div>
          {repos.map((r) => {
            const Icon = kindIcon(r.kind);
            const isActive = active?.absPath === r.absPath;
            return (
              <button
                key={r.absPath}
                type="button"
                disabled={!r.initialized}
                onClick={() => pick(r)}
                className={cn(
                  'w-full flex items-center gap-2 px-2 py-1 rounded text-[11.5px] text-left transition-colors',
                  r.initialized ? 'hover:bg-muted/60' : 'opacity-45 cursor-not-allowed',
                  isActive && 'bg-primary/10',
                )}
              >
                <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="truncate flex-1">{label(r)}</span>
                {!r.initialized && (
                  <span className="text-[9px] text-amber-500 shrink-0">{t('git.repos.uninitialized')}</span>
                )}
                {r.kind !== 'main' && r.initialized && (
                  <span className="text-[9px] uppercase tracking-wide text-muted-foreground/60 shrink-0">
                    {t(`git.repos.kind.${r.kind}` as const)}
                  </span>
                )}
                {isActive && <Check className="h-3 w-3 shrink-0 text-primary" />}
              </button>
            );
          })}
        </PopoverContent>
      </Popover>
    </div>
  );
}
