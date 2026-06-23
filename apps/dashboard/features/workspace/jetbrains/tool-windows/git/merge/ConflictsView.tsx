/**
 * Conflicts sub-tab body — lists every conflicted file with quick
 * resolutions (Accept Yours / Accept Theirs) and entry points into the
 * editors (3-pane merge, or the plain editor for hand-merging). Clicking
 * the row opens the 3-pane merge editor — the headline resolution path.
 */

import { ArrowLeftToLine, ArrowRightToLine, Check, CheckCheck, FileWarning, GitMerge, Pencil } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { GitMergeState } from '@mcp/api-bus';
import { cn } from '../../../../../../lib/utils.js';
import { useConflictActions } from './use-conflict-actions.js';

interface ConflictsViewProps {
  projectId: number;
  state: GitMergeState;
  onMutated: () => void;
}

export function ConflictsView({ projectId, state, onMutated }: ConflictsViewProps) {
  const { t } = useTranslation('workspace');
  const { acceptOurs, acceptTheirs, markResolved, openInEditor, openMergeTab } = useConflictActions(projectId, onMutated);

  if (state.conflictedFiles.length === 0) {
    return (
      <div className="flex-1 grid place-items-center px-6 py-10 text-center text-muted-foreground gap-2">
        <Check className="h-5 w-5 text-emerald-500/70" />
        <p className="text-[11.5px]">{t('git.conflict.allResolved')}</p>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      {state.conflictedFiles.map((path) => (
        <ConflictRow
          key={path}
          path={path}
          onOpenMerge={() => openMergeTab(path)}
          onAcceptOurs={() => void acceptOurs(path)}
          onAcceptTheirs={() => void acceptTheirs(path)}
          onMarkResolved={() => void markResolved(path)}
          onOpenInEditor={() => openInEditor(path)}
          labels={{
            acceptYours: t('git.conflict.acceptYours'),
            acceptTheirs: t('git.conflict.acceptTheirs'),
            mergeEditor: t('git.conflict.openInMergeEditor'),
            inlineEditor: t('git.conflict.resolveInEditor'),
            markResolved: t('git.conflict.markResolved'),
          }}
        />
      ))}
    </div>
  );
}

interface ConflictRowProps {
  path: string;
  onOpenMerge: () => void;
  onAcceptOurs: () => void;
  onAcceptTheirs: () => void;
  onMarkResolved: () => void;
  onOpenInEditor: () => void;
  labels: { acceptYours: string; acceptTheirs: string; mergeEditor: string; inlineEditor: string; markResolved: string };
}

function ConflictRow({ path, onOpenMerge, onAcceptOurs, onAcceptTheirs, onMarkResolved, onOpenInEditor, labels }: ConflictRowProps) {
  const name = path.split('/').pop() ?? path;
  const dir = path.slice(0, path.length - name.length);
  return (
    <div
      className="group flex items-center gap-2 px-2.5 py-1 border-b last:border-b-0 text-[11.5px] cursor-pointer hover:bg-muted/40"
      onClick={onOpenMerge}
      title={labels.mergeEditor}
    >
      <FileWarning className="h-3 w-3 shrink-0 text-destructive" />
      <span className="truncate flex-1">
        <span className="font-medium">{name}</span>
        {dir && <span className="text-muted-foreground/60 ml-1">{dir.replace(/\/$/, '')}</span>}
      </span>
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
        <RowIconBtn label={labels.acceptYours} icon={ArrowLeftToLine} onClick={onAcceptOurs} />
        <RowIconBtn label={labels.acceptTheirs} icon={ArrowRightToLine} onClick={onAcceptTheirs} />
        <RowIconBtn label={labels.inlineEditor} icon={Pencil} onClick={onOpenInEditor} />
        <RowIconBtn label={labels.mergeEditor} icon={GitMerge} onClick={onOpenMerge} />
        <RowIconBtn label={labels.markResolved} icon={CheckCheck} onClick={onMarkResolved} />
      </div>
    </div>
  );
}

function RowIconBtn({
  label, icon: Icon, onClick,
}: { label: string; icon: React.ComponentType<{ className?: string }>; onClick: () => void }) {
  return (
    <button
      type="button"
      title={label}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={cn('h-5 w-5 grid place-items-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors')}
    >
      <Icon className="h-3 w-3" />
    </button>
  );
}
