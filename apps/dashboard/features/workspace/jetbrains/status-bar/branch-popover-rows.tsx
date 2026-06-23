/**
 * Presentational primitives for the `BranchPopover`:
 *   - ActionRow   → row in the quick-actions section (icon · label · hint)
 *   - BranchRow   → row in the branches list (icon · name · ahead/behind)
 *   - SectionHeader → uppercase section divider ("Local Branches", etc.)
 *
 * Kept dumb. All filtering / busy state is decided by the parent.
 */

import {
  ArrowRight,
  Check,
  ChevronRight,
  Loader2,
} from 'lucide-react';
import { cn } from '../../../../lib/utils.js';

export interface ActionRowProps {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  hint?: string;
  busy?: boolean;
  onClick: () => void;
  /** When set, the row only renders if its label substring-matches. */
  filter: string;
}

export function ActionRow({ icon: Icon, label, hint, busy, onClick, filter }: ActionRowProps) {
  const q = filter.trim().toLowerCase();
  if (q && !label.toLowerCase().includes(q)) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={cn(
        'w-full flex items-center gap-2 px-2.5 py-1 text-left text-foreground',
        'hover:bg-muted/50 disabled:opacity-60 disabled:hover:bg-transparent',
      )}
    >
      {busy ? (
        <Loader2 className="h-3 w-3 animate-spin shrink-0 text-muted-foreground" />
      ) : (
        <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
      )}
      <span className="flex-1 truncate">{label}</span>
      {hint && (
        <span className="text-[9.5px] text-muted-foreground/60 font-mono shrink-0">{hint}</span>
      )}
    </button>
  );
}

export interface BranchRowData {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  tipSubject: string;
}

export interface BranchRowProps {
  branch: BranchRowData;
  busy: boolean;
  onClick: () => void;
  /** Trailing `>` signalling that clicking opens an actions panel. */
  chevron?: boolean;
  /** Highlight as the row whose actions are currently shown beside the list. */
  selected?: boolean;
}

export function BranchRow({ branch, busy, onClick, chevron, selected }: BranchRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={cn(
        'group/br w-full flex items-center gap-1.5 px-2.5 py-1 text-left transition-colors disabled:opacity-60',
        selected ? 'bg-muted' : 'hover:bg-muted/40',
      )}
      title={branch.tipSubject ? `${branch.name}\n${branch.tipSubject}` : branch.name}
    >
      {busy ? (
        <Loader2 className="h-3 w-3 animate-spin shrink-0 text-muted-foreground" />
      ) : branch.isRemote ? (
        <ArrowRight className="h-3 w-3 shrink-0 text-sky-400/80" />
      ) : (
        // Invisible placeholder keeps the icon column aligned across rows
        // — locals don't get a leading icon, remotes do.
        <Check className="h-3 w-3 shrink-0 text-transparent" />
      )}
      <span
        className={cn(
          'truncate',
          branch.isRemote ? 'text-muted-foreground' : 'text-foreground',
        )}
      >
        {branch.name}
      </span>
      <span className="ml-auto flex items-center gap-1.5 text-[10px] text-muted-foreground shrink-0">
        {branch.ahead > 0 && <span className="text-emerald-400">↑{branch.ahead}</span>}
        {branch.behind > 0 && <span className="text-sky-400">↓{branch.behind}</span>}
        {chevron && (
          <ChevronRight className={cn('h-3 w-3 text-muted-foreground/50', selected && 'text-foreground')} />
        )}
      </span>
    </button>
  );
}
