/**
 * Working-tree pane for the Git tool window — three collapsible sections
 * (staged / unstaged / untracked) with row-level + bulk actions, plus the
 * inline commit box at the bottom. Extracted from GitWindow to keep that
 * container lean.
 */

import { useTranslation } from 'react-i18next';
import { Check, Loader2, Minus, Plus, Trash2, Undo2 } from 'lucide-react';
import { cn } from '../../../../../lib/utils.js';
import { HoverLabelButton } from '../../../../../components/ui/hover-label-button.js';
import { CollapsibleSection } from './CollapsibleSection.js';
import { CommitBox } from './CommitBox.js';
import { fileKind } from './file-kind.js';
// Tipos vêm do hook (fonte única). Evita a cópia local que dessincronizaria em
// silêncio se o shape divergir (dashboard não roda tsc). W4 decompose.
import type { GitStatus, GitStatusFile } from './use-git-window.js';
import type { GitStatusCounts } from '@mcp/api-bus';

interface ChangesPaneProps {
  projectId: number;
  /** Selected git root (submodule / nested repo); undefined = main repo. */
  repoPath?: string;
  status: GitStatus | null;
  error: string | null;
  groups: {
    staged: GitStatusFile[];
    unstaged: GitStatusFile[];
    untracked: GitStatusFile[];
  };
  counts: GitStatusCounts | null;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void | Promise<void>;
  openSections: { staged: boolean; unstaged: boolean; untracked: boolean };
  setOpenSections: React.Dispatch<
    React.SetStateAction<{ staged: boolean; unstaged: boolean; untracked: boolean }>
  >;
  showDiff: (file: GitStatusFile) => void | Promise<void>;
  onStage: (paths: string[]) => void | Promise<void>;
  onUnstage: (paths: string[]) => void | Promise<void>;
  onDiscard: (paths: string[]) => void | Promise<void>;
  onCommitted: () => void;
}

/**
 * Working-tree pane: three collapsible sections (staged / unstaged /
 * untracked) with row-level + bulk actions. The empty state asks the
 * user to make some changes; the inverse (everything committed) shows
 * a friendly "clean tree" message instead.
 */
export function ChangesPane({
  projectId,
  repoPath,
  status,
  error,
  groups,
  counts,
  hasMore,
  loadingMore,
  onLoadMore,
  openSections,
  setOpenSections,
  showDiff,
  onStage,
  onUnstage,
  onDiscard,
  onCommitted,
}: ChangesPaneProps) {
  const { t } = useTranslation('workspace');
  const total = counts?.total ?? groups.staged.length + groups.unstaged.length + groups.untracked.length;

  if (!status && !error) {
    return (
      <div className="flex-1 grid place-items-center text-[11px] text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin opacity-60" />
      </div>
    );
  }
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto">
      {status && total === 0 && (
        <div className="grid place-items-center px-6 py-10 text-center text-muted-foreground gap-2">
          <Check className="h-5 w-5 opacity-50" />
          <p className="text-[11.5px]">{t('git.cleanTree')}</p>
        </div>
      )}
      {groups.staged.length > 0 && (
        <CollapsibleSection
          title={t('git.staged', { count: groups.staged.length })}
          open={openSections.staged}
          onToggle={() => setOpenSections((s) => ({ ...s, staged: !s.staged }))}
          actions={
            <HoverLabelButton
              icon={Minus}
              label={t('git.unstageAll')}
              onClick={() => void onUnstage(groups.staged.map((f) => f.path))}
            />
          }
        >
          {groups.staged.map((f) => (
            <FileRow
              key={`s-${f.path}`}
              file={f}
              onClick={() => void showDiff(f)}
              actions={
                <RowButton
                  icon={Minus}
                  title={t('git.unstage')}
                  onClick={() => void onUnstage([f.path])}
                />
              }
            />
          ))}
        </CollapsibleSection>
      )}

      {groups.unstaged.length > 0 && (
        <CollapsibleSection
          title={t('git.changes', { count: groups.unstaged.length })}
          open={openSections.unstaged}
          onToggle={() => setOpenSections((s) => ({ ...s, unstaged: !s.unstaged }))}
          actions={
            <div className="flex items-center gap-1">
              <HoverLabelButton
                icon={Undo2}
                label={t('git.discardAll')}
                tone="destructive"
                onClick={() => void onDiscard(groups.unstaged.map((f) => f.path))}
              />
              <HoverLabelButton
                icon={Plus}
                label={t('git.stageAll')}
                onClick={() => void onStage(groups.unstaged.map((f) => f.path))}
              />
            </div>
          }
        >
          {groups.unstaged.map((f) => (
            <FileRow
              key={`u-${f.path}`}
              file={f}
              onClick={() => void showDiff(f)}
              actions={
                <>
                  <RowButton
                    icon={Undo2}
                    title={t('git.discard')}
                    destructive
                    onClick={() => void onDiscard([f.path])}
                  />
                  <RowButton
                    icon={Plus}
                    title={t('git.stage')}
                    onClick={() => void onStage([f.path])}
                  />
                </>
              }
            />
          ))}
        </CollapsibleSection>
      )}

      {groups.untracked.length > 0 && (
        <CollapsibleSection
          title={t('git.untracked', { count: groups.untracked.length })}
          open={openSections.untracked}
          onToggle={() =>
            setOpenSections((s) => ({ ...s, untracked: !s.untracked }))
          }
          actions={
            <div className="flex items-center gap-1">
              <HoverLabelButton
                icon={Trash2}
                label={t('git.deleteAll')}
                tone="destructive"
                onClick={() => void onDiscard(groups.untracked.map((f) => f.path))}
              />
              <HoverLabelButton
                icon={Plus}
                label={t('git.stageAll')}
                onClick={() => void onStage(groups.untracked.map((f) => f.path))}
              />
            </div>
          }
        >
          {groups.untracked.map((f) => (
            <FileRow
              key={`?-${f.path}`}
              file={f}
              actions={
                <>
                  <RowButton
                    icon={Trash2}
                    title={t('git.deleteFile')}
                    destructive
                    onClick={() => void onDiscard([f.path])}
                  />
                  <RowButton
                    icon={Plus}
                    title={t('git.stage')}
                    onClick={() => void onStage([f.path])}
                  />
                </>
              }
            />
          ))}
        </CollapsibleSection>
      )}
      {hasMore && (
        <div className="flex justify-center p-2">
          <button
            type="button"
            onClick={() => void onLoadMore()}
            disabled={loadingMore}
            className="rounded border px-3 py-1 text-[11px] text-muted-foreground hover:bg-muted disabled:opacity-50"
          >
            {loadingMore ? t('git.loadingMore') : t('git.loadMoreChanges', { loaded: groups.staged.length + groups.unstaged.length + groups.untracked.length, total })}
          </button>
        </div>
      )}
      {status?.partialWarnings?.map((warning) => (
        <div key={warning} className="mx-2 my-1 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-700 dark:text-amber-300">
          {warning}
        </div>
      ))}
      </div>
      <CommitBox
        projectId={projectId}
        repoPath={repoPath}
        stagedCount={groups.staged.length}
        upstream={status?.upstream ?? null}
        onCommitted={onCommitted}
      />
    </div>
  );
}

function FileRow({
  file,
  actions,
  onClick,
}: {
  file: GitStatusFile;
  actions: React.ReactNode;
  onClick?: () => void;
}) {
  const { t } = useTranslation('workspace');
  const k = fileKind(file.state);
  return (
    <div
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      className={cn(
        'group flex items-center gap-2 px-2.5 py-1 transition-colors border-b last:border-b-0 text-[11.5px]',
        onClick ? 'cursor-pointer hover:bg-muted/40' : 'hover:bg-muted/40',
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
      <span className={cn('font-mono text-[10px] w-3 shrink-0 text-center', k.color)}>
        {k.letter}
      </span>
      <span className="truncate flex-1">{file.path}</span>
      {file.outsideProject && <span className="text-[9px] text-amber-600">{t('git.outsideProject')}</span>}
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
        {actions}
      </div>
    </div>
  );
}

function RowButton({
  icon: Icon,
  title,
  onClick,
  destructive,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        'h-5 w-5 grid place-items-center rounded-sm transition-colors',
        destructive
          ? 'text-muted-foreground hover:text-destructive hover:bg-destructive/10'
          : 'text-muted-foreground hover:text-foreground hover:bg-muted',
      )}
    >
      <Icon className="h-3 w-3" />
    </button>
  );
}
