/**
 * Sub-tab strip estreito do Git tool window (extraído do GitWindow — W4 decompose).
 * Cada aba é ícone + label curto; a ativa ganha um stripe de acento no topo (convenção
 * do rail/IDE). Ordem importa: Changes (mais comum), Branches, History, Stash, Conflicts
 * (só durante uma op de sequencer), AI por último (escape "não sei o comando git").
 *
 * Label: só a aba ATIVA mantém o texto; inativas colapsam pra só-ícone e deslizam o
 * label em hover/foco (transição max-width+opacity). Mesmo padrão do `NavButton` do
 * menu superior (AppShell) — economiza espaço horizontal e dá foco visual ao ativo.
 */
import { useTranslation } from 'react-i18next';
import { Archive, GitBranch, GitCommit as GitCommitIcon, GitMerge, History, Sparkles } from 'lucide-react';
import { cn } from '../../../../../lib/utils.js';

export type GitTab = 'changes' | 'branches' | 'history' | 'stash' | 'ai' | 'conflicts';

interface GitTabNavProps {
  active: GitTab;
  onChange: (t: GitTab) => void;
  /** Número de arquivos em conflito quando uma op de sequencer está ativa; null = aba oculta. */
  conflictCount: number | null;
}

export function GitTabNav({ active, onChange, conflictCount }: GitTabNavProps) {
  const { t } = useTranslation('workspace');
  const tabs: {
    id: GitTab;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    badge?: number;
  }[] = [
    { id: 'changes', label: t('git.tabs.changes'), icon: GitCommitIcon },
    { id: 'branches', label: t('git.tabs.branches'), icon: GitBranch },
    { id: 'history', label: t('git.tabs.history'), icon: History },
    { id: 'stash', label: t('git.tabs.stash'), icon: Archive },
    // Conflicts tab only exists while a sequencer op is mid-flight.
    ...(conflictCount !== null
      ? [{ id: 'conflicts' as const, label: t('git.tabs.conflicts'), icon: GitMerge, badge: conflictCount }]
      : []),
    { id: 'ai', label: t('git.tabs.ai'), icon: Sparkles },
  ];
  return (
    <div className="shrink-0 flex items-stretch border-b bg-card/30">
      {tabs.map(({ id, label, icon: Icon, badge }) => {
        const isActive = active === id;
        const isConflicts = id === 'conflicts';
        return (
          <button
            key={id}
            type="button"
            onClick={() => onChange(id)}
            aria-label={label}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'group/gittab relative flex items-center px-3 py-1.5 text-[11px] transition-colors',
              isActive
                ? 'text-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/40',
              isConflicts && 'text-amber-500',
            )}
          >
            <Icon className={cn('h-3 w-3 shrink-0', isActive && id === 'ai' && 'text-primary')} />
            {/* Active mantém o label; inativa colapsa e desliza no hover/foco. ml em
                vez de gap no botão para o label de largura-zero não reservar espaço. */}
            <span
              className={cn(
                'overflow-hidden whitespace-nowrap font-medium transition-all duration-150 ease-out',
                isActive
                  ? 'ml-1.5 max-w-[120px] opacity-100'
                  : 'ml-0 max-w-0 opacity-0 group-hover/gittab:ml-1.5 group-hover/gittab:max-w-[120px] group-hover/gittab:opacity-100 group-focus-visible/gittab:ml-1.5 group-focus-visible/gittab:max-w-[120px] group-focus-visible/gittab:opacity-100',
              )}
            >
              {label}
            </span>
            {badge !== undefined && badge > 0 && (
              <span className="ml-1.5 grid place-items-center min-w-[14px] h-[14px] px-1 rounded-full bg-amber-500/20 text-amber-500 text-[9px] font-semibold">
                {badge}
              </span>
            )}
            {isActive && (
              <span className="absolute inset-x-1 top-0 h-[2px] bg-primary rounded-full" />
            )}
          </button>
        );
      })}
    </div>
  );
}
