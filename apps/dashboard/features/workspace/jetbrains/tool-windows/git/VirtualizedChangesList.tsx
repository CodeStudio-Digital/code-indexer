/**
 * One virtualized scroll surface for every working-tree group. Section headers
 * and file rows share the same virtualizer, so large staged/unstaged/untracked
 * sets do not mount hundreds of hidden DOM nodes.
 */
import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Check, Minus, Plus, Trash2, Undo2 } from 'lucide-react';
import { FileIcon } from '../../../../../components/FileIcon.js';
import { cn } from '../../../../../lib/utils.js';
import { CollapsibleSectionHeader } from './CollapsibleSection.js';
import { changePathParts } from './change-path.js';
import { fileKind } from './file-kind.js';
import {
  changeSelectionState,
  isChangeSelected,
  pruneChangeSelection,
  selectedChangePaths,
  toggleChangeGroupSelection,
  toggleChangeSelection,
  type ChangeSelectionState,
  type SelectableChangeGroup,
} from './change-selection.js';
import type { GitStatusFile } from './use-git-window.js';

export type GitChangeGroups = Record<SelectableChangeGroup, GitStatusFile[]>;
export type GitChangeSections = Record<SelectableChangeGroup, boolean>;

interface VirtualizedChangesListProps {
  projectId: number;
  repoPath?: string;
  groups: GitChangeGroups;
  total: number;
  warnings: string[];
  openSections: GitChangeSections;
  setOpenSections: React.Dispatch<React.SetStateAction<GitChangeSections>>;
  showDiff: (file: GitStatusFile) => void | Promise<void>;
  onStage: (paths: string[]) => void | Promise<void>;
  onUnstage: (paths: string[]) => void | Promise<void>;
  onDiscard: (paths: string[]) => void | Promise<void>;
}

type ChangeListRow =
  | { kind: 'empty' }
  | { kind: 'section'; group: SelectableChangeGroup }
  | { kind: 'file'; group: SelectableChangeGroup; file: GitStatusFile }
  | { kind: 'warning'; key: string; message: string };

const GROUP_ORDER: readonly SelectableChangeGroup[] = ['staged', 'unstaged', 'untracked'];

const GROUP_VISUALS: Record<SelectableChangeGroup, {
  header: string;
  title: string;
  dot: string;
  row: string;
}> = {
  staged: {
    header: 'border-l-2 border-l-emerald-500/80 bg-emerald-500/[0.09] dark:bg-emerald-500/[0.07]',
    title: 'text-emerald-700 dark:text-emerald-300',
    dot: 'bg-emerald-500',
    row: 'border-l-2 border-l-emerald-500/25',
  },
  unstaged: {
    header: 'border-l-2 border-l-amber-500/80 bg-amber-500/[0.09] dark:bg-amber-500/[0.07]',
    title: 'text-amber-700 dark:text-amber-300',
    dot: 'bg-amber-500',
    row: 'border-l-2 border-l-amber-500/25',
  },
  untracked: {
    header: 'border-l-2 border-l-sky-500/80 bg-sky-500/[0.09] dark:bg-sky-500/[0.07]',
    title: 'text-sky-700 dark:text-sky-300',
    dot: 'bg-sky-500',
    row: 'border-l-2 border-l-sky-500/25',
  },
};

function rowKey(row: ChangeListRow): string {
  if (row.kind === 'empty') return 'empty';
  if (row.kind === 'warning') return row.key;
  if (row.kind === 'section') return `section:${row.group}`;
  return `file:${row.group}:${row.file.path}`;
}

export function VirtualizedChangesList({
  projectId,
  repoPath,
  groups,
  total,
  warnings,
  openSections,
  setOpenSections,
  showDiff,
  onStage,
  onUnstage,
  onDiscard,
}: VirtualizedChangesListProps) {
  const { t } = useTranslation('workspace');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [excludedChanges, setExcludedChanges] = useState<Set<string>>(() => new Set());

  const selectedPaths = useMemo(() => ({
    staged: selectedChangePaths('staged', groups.staged, excludedChanges),
    unstaged: selectedChangePaths('unstaged', groups.unstaged, excludedChanges),
    untracked: selectedChangePaths('untracked', groups.untracked, excludedChanges),
  }), [excludedChanges, groups]);
  const selectionStates = useMemo(() => ({
    staged: changeSelectionState('staged', groups.staged, excludedChanges),
    unstaged: changeSelectionState('unstaged', groups.unstaged, excludedChanges),
    untracked: changeSelectionState('untracked', groups.untracked, excludedChanges),
  }), [excludedChanges, groups]);

  useEffect(() => setExcludedChanges(new Set()), [projectId, repoPath]);
  useEffect(() => {
    setExcludedChanges((current) => {
      const next = pruneChangeSelection(groups, current);
      if (next.size === current.size && [...next].every((key) => current.has(key))) return current;
      return next;
    });
  }, [groups]);

  const rows = useMemo<ChangeListRow[]>(() => {
    const next: ChangeListRow[] = [];
    if (total === 0) next.push({ kind: 'empty' });
    for (const group of GROUP_ORDER) {
      if (groups[group].length === 0) continue;
      next.push({ kind: 'section', group });
      if (openSections[group]) {
        for (const file of groups[group]) next.push({ kind: 'file', group, file });
      }
    }
    warnings.forEach((message, index) => next.push({ kind: 'warning', key: `warning:${index}:${message}`, message }));
    return next;
  }, [groups, openSections, total, warnings]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => rows[index]?.kind === 'empty'
      ? 88
        : rows[index]?.kind === 'warning'
          ? 38
          : rows[index]?.kind === 'section'
            ? 32
            : 36,
    getItemKey: (index) => rowKey(rows[index]!),
    overscan: 12,
  });

  useEffect(() => {
    virtualizer.scrollToOffset(0);
  }, [projectId, repoPath]); // eslint-disable-line react-hooks/exhaustive-deps -- reset only when the repository changes

  const toggleGroup = (group: SelectableChangeGroup) => {
    setExcludedChanges((current) => toggleChangeGroupSelection(group, groups[group], current));
  };
  const toggleFile = (group: SelectableChangeGroup, path: string) => {
    setExcludedChanges((current) => toggleChangeSelection(group, path, current));
  };
  const toggleSection = (group: SelectableChangeGroup) => {
    setOpenSections((current) => ({ ...current, [group]: !current[group] }));
  };

  const renderSection = (group: SelectableChangeGroup) => {
    const state = selectionStates[group];
    const paths = selectedPaths[group];
    const visual = GROUP_VISUALS[group];
    const title = group === 'staged'
      ? t('git.staged', { count: groups.staged.length })
      : group === 'unstaged'
        ? t('git.changes', { count: groups.unstaged.length })
        : t('git.untracked', { count: groups.untracked.length });
    const selectionLabel = group === 'staged'
      ? t(state === 'all' ? 'git.deselectAllStaged' : 'git.selectAllStaged')
      : group === 'unstaged'
        ? t(state === 'all' ? 'git.deselectAllChanges' : 'git.selectAllChanges')
        : t(state === 'all' ? 'git.deselectAllUntracked' : 'git.selectAllUntracked');

    const bulkActions = group === 'staged' ? (
      <HeaderActionButton
        icon={Minus}
        title={t('git.unstageSelected', { count: paths.length })}
        disabled={paths.length === 0}
        onClick={() => void onUnstage(paths)}
      />
    ) : group === 'unstaged' ? (
      <div className="flex items-center gap-1">
        <HeaderActionButton
          icon={Undo2}
          title={t('git.discardSelected', { count: paths.length })}
          destructive
          disabled={paths.length === 0}
          onClick={() => void onDiscard(paths)}
        />
        <HeaderActionButton
          icon={Plus}
          title={t('git.stageSelected', { count: paths.length })}
          disabled={paths.length === 0}
          onClick={() => void onStage(paths)}
        />
      </div>
    ) : (
      <div className="flex items-center gap-1">
        <HeaderActionButton
          icon={Trash2}
          title={t('git.deleteSelected', { count: paths.length })}
          destructive
          disabled={paths.length === 0}
          onClick={() => void onDiscard(paths)}
        />
        <HeaderActionButton
          icon={Plus}
          title={t('git.stageSelected', { count: paths.length })}
          disabled={paths.length === 0}
          onClick={() => void onStage(paths)}
        />
      </div>
    );

    return (
      <CollapsibleSectionHeader
        title={title}
        open={openSections[group]}
        onToggle={() => toggleSection(group)}
        sticky={false}
        className={cn('min-h-8 border-y shadow-sm', visual.header)}
        titleClassName={visual.title}
        headerControl={(
          <span className={cn('mx-0.5 h-1.5 w-1.5 shrink-0 rounded-full', visual.dot)} aria-hidden="true" />
        )}
        actions={(
          <div className="flex items-center gap-1">
            <div className="mr-0.5 flex h-5 items-center border-r border-border/70 pr-1.5">
              <SelectionCheckbox
                state={state}
                label={selectionLabel}
                onToggle={() => toggleGroup(group)}
              />
            </div>
            {bulkActions}
          </div>
        )}
      />
    );
  };

  const renderFile = (group: SelectableChangeGroup, file: GitStatusFile) => {
    const checked = isChangeSelected(group, file.path, excludedChanges);
    const actions = group === 'staged' ? (
      <RowButton icon={Minus} title={t('git.unstage')} onClick={() => void onUnstage([file.path])} />
    ) : group === 'unstaged' ? (
      <>
        <RowButton icon={Undo2} title={t('git.discard')} destructive onClick={() => void onDiscard([file.path])} />
        <RowButton icon={Plus} title={t('git.stage')} onClick={() => void onStage([file.path])} />
      </>
    ) : (
      <>
        <RowButton icon={Trash2} title={t('git.deleteFile')} destructive onClick={() => void onDiscard([file.path])} />
        <RowButton icon={Plus} title={t('git.stage')} onClick={() => void onStage([file.path])} />
      </>
    );
    return (
      <FileRow
        group={group}
        file={file}
        onClick={group === 'untracked' ? undefined : () => void showDiff(file)}
        selection={{
          checked,
          label: t(checked ? 'git.deselectFile' : 'git.selectFile', { path: file.path }),
          onToggle: () => toggleFile(group, file.path),
        }}
        actions={actions}
      />
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1.5 border-b bg-muted/25 px-2.5 py-1 text-[9.5px] text-muted-foreground">
        <span className="grid h-3.5 w-3.5 shrink-0 place-items-center rounded-[3px] border border-primary/60 bg-primary/10 text-primary" aria-hidden="true">
          <Check className="h-2.5 w-2.5" />
        </span>
        <span className="truncate" title={t('git.selectionHint')}>{t('git.selectionHint')}</span>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index]!;
            return (
              <div
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                className="will-change-transform"
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${item.start}px)`,
                }}
              >
                {row.kind === 'empty' && (
                  <div className="grid place-items-center gap-2 px-6 py-10 text-center text-muted-foreground">
                    <Check className="h-5 w-5 opacity-50" />
                    <p className="text-[11.5px]">{t('git.cleanTree')}</p>
                  </div>
                )}
                {row.kind === 'section' && renderSection(row.group)}
                {row.kind === 'file' && renderFile(row.group, row.file)}
                {row.kind === 'warning' && (
                  <div className="mx-2 my-1 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-700 dark:text-amber-300">
                    {row.message}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function FileRow({
  group,
  file,
  actions,
  onClick,
  selection,
}: {
  group: SelectableChangeGroup;
  file: GitStatusFile;
  actions: ReactNode;
  onClick?: () => void;
  selection: { checked: boolean; label: string; onToggle: () => void };
}) {
  const { t } = useTranslation('workspace');
  const kind = fileKind(file.state);
  const { name, directory } = changePathParts(file.path);
  return (
    <div
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      className={cn(
        'group flex items-center gap-1.5 border-b bg-background/70 py-1 pl-5 pr-2.5 text-[11.5px] transition-colors hover:bg-muted/40',
        GROUP_VISUALS[group].row,
        onClick && 'cursor-pointer',
      )}
      onClick={onClick}
      onKeyDown={(event) => {
        if (onClick && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          onClick();
        }
      }}
      title={onClick ? t('git.openDiffFor', { path: file.path }) : file.path}
    >
      <SelectionCheckbox
        state={selection.checked ? 'all' : 'none'}
        label={selection.label}
        onToggle={selection.onToggle}
      />
      <span className={cn('w-3 shrink-0 text-center font-mono text-[10px]', kind.color)}>{kind.letter}</span>
      <FileIcon path={file.path} className="h-3.5 w-3.5 opacity-90" />
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate font-medium text-foreground">{name}</span>
        <span className="block truncate text-[9.5px] text-muted-foreground" title={directory}>{directory}</span>
      </span>
      {file.outsideProject && <span className="text-[9px] text-amber-600">{t('git.outsideProject')}</span>}
      <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        {actions}
      </div>
    </div>
  );
}

function SelectionCheckbox({ state, label, onToggle }: {
  state: ChangeSelectionState;
  label: string;
  onToggle: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'partial';
  }, [state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={state === 'all'}
      aria-checked={state === 'partial' ? 'mixed' : state === 'all'}
      aria-label={label}
      title={label}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onChange={onToggle}
      className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-primary"
    />
  );
}

function RowButton({ icon: Icon, title, onClick, destructive }: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={cn(
        'grid h-5 w-5 place-items-center rounded-sm transition-colors',
        destructive
          ? 'text-muted-foreground hover:bg-destructive/10 hover:text-destructive'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      <Icon className="h-3 w-3" />
    </button>
  );
}

function HeaderActionButton({ icon: Icon, title, onClick, destructive, disabled }: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  onClick: () => void;
  destructive?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'grid h-5 w-5 place-items-center rounded-sm transition-colors disabled:opacity-50',
        destructive
          ? 'text-muted-foreground hover:bg-destructive/10 hover:text-destructive'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      <Icon className="h-3 w-3" />
    </button>
  );
}
