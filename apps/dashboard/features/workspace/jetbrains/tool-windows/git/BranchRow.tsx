/**
 * One branch row in the Branches tab. Clicking the row OPENS the branch
 * log in the content area (it no longer checks out — that was a footgun:
 * an accidental click switched your branch). Every action lives behind a
 * right-click context menu (or the hover "⋯" button), JetBrains-style —
 * the item set comes from the shared `buildBranchActions` builder.
 */

import { GitBranch as GitBranchIcon, MoreHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { GitBranch } from '@mcp/api-bus';
import { useContextMenu } from '../../../../../components/ui/context-menu.js';
import { cn } from '../../../../../lib/utils.js';
import { buildBranchActions } from './branch-menu.js';
import type { BranchActions } from './use-branch-ops.js';

export function BranchRow({
  branch: b,
  actions,
  opInProgress,
}: { branch: GitBranch; actions: BranchActions; opInProgress?: boolean }) {
  const { t } = useTranslation('workspace');
  const { triggerProps, Menu } = useContextMenu(buildBranchActions(b, actions, {
    opInProgress,
    t: (key, options) => t(key, options),
  }));

  return (
    <>
      <div
        {...triggerProps}
        className={cn(
          'group flex items-center gap-1.5 px-2 py-1 border-b last:border-b-0 text-[11.5px] cursor-pointer transition-colors',
          b.isCurrent ? 'bg-primary/5' : 'hover:bg-muted/40',
        )}
        onClick={() => actions.onOpenLog(b)}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            actions.onOpenLog(b);
          }
        }}
        title={t('git.branch.openActions')}
      >
        <GitBranchIcon
          className={cn(
            'h-3 w-3 shrink-0',
            b.isCurrent ? 'text-primary' : b.isRemote ? 'text-sky-400' : 'text-muted-foreground/80',
          )}
        />
        <span
          className={cn(
            'truncate font-medium',
            b.isCurrent && 'text-foreground',
            b.isRemote && !b.isCurrent && 'text-muted-foreground',
          )}
        >
          {b.name}
        </span>
        {b.upstream && !b.isRemote && (
          <span className="text-[10px] text-muted-foreground/70 truncate">→ {b.upstream}</span>
        )}
        <span className="ml-auto flex items-center gap-2 text-[10px] text-muted-foreground shrink-0">
          {b.ahead > 0 && <span className="text-emerald-400">↑{b.ahead}</span>}
          {b.behind > 0 && <span className="text-sky-400">↓{b.behind}</span>}
        </span>
        <button
          type="button"
          className="h-5 w-5 grid place-items-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
          aria-label={t('git.branch.actions')}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const evt = new MouseEvent('contextmenu', {
              bubbles: true,
              cancelable: true,
              view: window,
              clientX: rect.left,
              clientY: rect.bottom,
            });
            (e.currentTarget as HTMLElement).dispatchEvent(evt);
          }}
        >
          <MoreHorizontal className="h-3 w-3" />
        </button>
      </div>
      {Menu}
    </>
  );
}
