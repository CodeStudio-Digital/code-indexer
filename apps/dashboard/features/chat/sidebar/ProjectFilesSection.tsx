import { memo, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, ChevronRight, FolderTree, Minus, Search, X } from 'lucide-react';
import { CollapsibleSection } from './CollapsibleSection.js';
import {
  useProjectFiles,
  type ProjectTreeNode,
  type SearchResult,
} from './useProjectFiles.js';
import { cn } from '../../../lib/utils.js';
import { FileIcon, FolderIcon } from '../../../components/FileIcon.js';

interface ProjectFilesSectionProps {
  sessionId: string;
  projectId: number;
  selected: string[];
  onToggleSelect: (path: string) => void;
  onSetMany: (paths: string[], select: boolean) => void;
}

type FolderState = 'none' | 'partial' | 'all';

export const ProjectFilesSection = memo(function ProjectFilesSection({
  sessionId,
  projectId,
  selected,
  onToggleSelect,
  onSetMany,
}: ProjectFilesSectionProps) {
  const { t } = useTranslation('chat');
  const { root, expanded, toggleExpand, error, search, setSearch, searchState } =
    useProjectFiles(projectId);
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const folderStateOf = useCallback((folderPath: string): FolderState => {
    const prefix = `${folderPath}/`;
    return selected.some((p) => p.startsWith(prefix)) ? 'partial' : 'none';
  }, [selected]);

  const toggleFolder = useCallback(async (folderPath: string, currentState: FolderState) => {
    if (currentState !== 'none') {
      const prefix = `${folderPath}/`;
      const toRemove = selected.filter((p) => p.startsWith(prefix));
      onSetMany(toRemove, false);
      return;
    }
    try {
      const r = await fetch(
        `/api/coder/projects/${projectId}/tree?path=${encodeURIComponent(folderPath)}&recursive=1`,
      );
      if (!r.ok) return;
      const data = (await r.json()) as { files: string[]; truncated: boolean };
      onSetMany(data.files, true);
    } catch {
      /* ignore */
    }
  }, [onSetMany, projectId, selected]);

  const headerExtra =
    selected.length > 0 ? (
      <span className="min-w-5 rounded-full bg-primary/12 px-1.5 py-0.5 text-center text-[10px] font-semibold text-primary">
        {selected.length}
      </span>
    ) : null;

  return (
    <CollapsibleSection
      id="files"
      sessionId={sessionId}
      title={t('files.title')}
      icon={<FolderTree className="h-3.5 w-3.5 text-muted-foreground" />}
      headerExtra={headerExtra}
      defaultOpen={false}
    >
      <div className="border-t border-border/40">
        <div className="border-b border-border/50 bg-muted/10 px-2 py-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/80" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('files.search')}
              className="h-7 w-full rounded-sm border border-border/80 bg-background pl-7 pr-7 text-[11px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 hover:border-border focus:border-primary/70 focus:ring-1 focus:ring-primary/20"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-1.5 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>

          {error && (
            <div className="mt-1.5 rounded-sm border border-destructive/25 bg-destructive/10 px-2 py-1 text-[10px] text-destructive">
              {error}
            </div>
          )}
        </div>

        <div className="px-1 py-1.5">
          {searchState ? (
            <SearchResults
              state={searchState}
              selectedSet={selectedSet}
              onToggleSelect={onToggleSelect}
              tLoading={t('files.searching')}
              tEmpty={t('files.noMatches')}
              tTruncated={t('files.truncated')}
            />
          ) : (
            <TreeView
              root={root}
              expanded={expanded}
              selectedSet={selectedSet}
              onToggleExpand={toggleExpand}
              onToggleSelect={onToggleSelect}
              folderStateOf={folderStateOf}
              onToggleFolder={toggleFolder}
              tLoading={t('files.loading')}
              tEmpty={t('files.empty')}
            />
          )}
        </div>
      </div>
    </CollapsibleSection>
  );
});

const TreeView = memo(function TreeView({
  root,
  expanded,
  selectedSet,
  onToggleExpand,
  onToggleSelect,
  folderStateOf,
  onToggleFolder,
  tLoading,
  tEmpty,
}: {
  root: ProjectTreeNode | null;
  expanded: Set<string>;
  selectedSet: Set<string>;
  onToggleExpand: (n: ProjectTreeNode) => void;
  onToggleSelect: (path: string) => void;
  folderStateOf: (path: string) => FolderState;
  onToggleFolder: (path: string, current: FolderState) => void;
  tLoading: string;
  tEmpty: string;
}) {
  if (!root) {
    return <div className="px-2 py-4 text-center text-[10px] text-muted-foreground">{tLoading}</div>;
  }
  const children = root.children ?? [];
  if (children.length === 0) {
    return <div className="px-2 py-4 text-center text-[10px] text-muted-foreground">{tEmpty}</div>;
  }
  return (
    <ul role="tree" className="space-y-px">
      {children.map((c) => (
        <FileNode
          key={c.path}
          node={c}
          depth={0}
          expanded={expanded}
          selectedSet={selectedSet}
          onToggleExpand={onToggleExpand}
          onToggleSelect={onToggleSelect}
          folderStateOf={folderStateOf}
          onToggleFolder={onToggleFolder}
        />
      ))}
    </ul>
  );
});

const FileNode = memo(function FileNode({
  node,
  depth,
  expanded,
  selectedSet,
  onToggleExpand,
  onToggleSelect,
  folderStateOf,
  onToggleFolder,
}: {
  node: ProjectTreeNode;
  depth: number;
  expanded: Set<string>;
  selectedSet: Set<string>;
  onToggleExpand: (n: ProjectTreeNode) => void;
  onToggleSelect: (path: string) => void;
  folderStateOf: (path: string) => FolderState;
  onToggleFolder: (path: string, current: FolderState) => void;
}) {
  const isOpen = expanded.has(node.path);
  const isSelected = selectedSet.has(node.path);

  if (node.type === 'dir') {
    const folderState = folderStateOf(node.path);
    return (
      <li role="none">
        <div
          role="treeitem"
          aria-expanded={isOpen}
          className="group flex h-[22px] w-full select-none items-center rounded-sm pl-1 pr-1.5 text-[length:var(--ide-tree-font,11.5px)] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title={node.path}
        >
          <IndentGuides depth={depth} />
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <button
              type="button"
              onClick={() => onToggleExpand(node)}
              className="grid w-3 shrink-0 place-items-center text-muted-foreground/70 hover:text-foreground"
              aria-label={isOpen ? 'Collapse' : 'Expand'}
            >
              {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            </button>
            <SelectionButton
              state={folderState}
              onClick={() => onToggleFolder(node.path, folderState)}
              label={`${folderState === 'none' ? 'Select' : 'Clear'} ${node.path}`}
            />
            <button
              type="button"
              onClick={() => onToggleExpand(node)}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            >
              <FolderIcon name={node.name} expanded={isOpen} className="h-3.5 w-3.5" />
              <span className="truncate">{node.name}</span>
            </button>
          </span>
        </div>
        {isOpen && node.children && (
          <ul role="group" className="space-y-px">
            {node.children.map((c) => (
              <FileNode
                key={c.path}
                node={c}
                depth={depth + 1}
                expanded={expanded}
                selectedSet={selectedSet}
                onToggleExpand={onToggleExpand}
                onToggleSelect={onToggleSelect}
                folderStateOf={folderStateOf}
                onToggleFolder={onToggleFolder}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }

  return (
    <li role="none">
      <button
        type="button"
        role="treeitem"
        aria-selected={isSelected}
        onClick={() => onToggleSelect(node.path)}
        className={cn(
          'group flex h-[22px] w-full select-none items-center rounded-sm pl-1 pr-1.5 text-left text-[length:var(--ide-tree-font,11.5px)] transition-colors',
          isSelected
            ? 'bg-accent text-foreground'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        )}
        title={node.path}
      >
        <IndentGuides depth={depth} />
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="w-3 shrink-0" aria-hidden="true" />
          <SelectionMark state={isSelected ? 'all' : 'none'} />
          <FileIcon path={node.path} className="h-3.5 w-3.5" />
          <span className={cn('truncate', isSelected && 'font-medium')}>{node.name}</span>
        </span>
      </button>
    </li>
  );
});

function IndentGuides({ depth }: { depth: number }) {
  if (depth <= 0) return null;
  return (
    <span className="flex shrink-0" aria-hidden="true">
      {Array.from({ length: depth }, (_, index) => (
        <span key={index} className="flex w-3 shrink-0 justify-center">
          <span className="w-px bg-border/70" />
        </span>
      ))}
    </span>
  );
}

function SelectionButton({
  state,
  onClick,
  label,
}: {
  state: FolderState;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={state !== 'none'}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className="grid h-4 w-4 shrink-0 place-items-center rounded-[3px] outline-none focus-visible:ring-1 focus-visible:ring-primary"
    >
      <SelectionMark state={state} />
    </button>
  );
}

function SelectionMark({ state }: { state: FolderState }) {
  return (
    <span
      className={cn(
        'grid h-3.5 w-3.5 shrink-0 place-items-center rounded-[3px] border transition-colors',
        state === 'none'
          ? 'border-muted-foreground/35 bg-background/70 group-hover:border-muted-foreground/55'
          : 'border-primary/70 bg-primary/15 text-primary',
      )}
      aria-hidden="true"
    >
      {state === 'all' ? <Check className="h-2.5 w-2.5 stroke-[2.5]" /> : null}
      {state === 'partial' ? <Minus className="h-2.5 w-2.5 stroke-[2.5]" /> : null}
    </span>
  );
}

const SearchResults = memo(function SearchResults({
  state,
  selectedSet,
  onToggleSelect,
  tLoading,
  tEmpty,
  tTruncated,
}: {
  state: { query: string; results: SearchResult[]; truncated: boolean; loading: boolean };
  selectedSet: Set<string>;
  onToggleSelect: (path: string) => void;
  tLoading: string;
  tEmpty: string;
  tTruncated: string;
}) {
  if (state.loading) {
    return <div className="px-2 py-4 text-center text-[10px] text-muted-foreground">{tLoading}</div>;
  }
  if (state.results.length === 0) {
    return <div className="px-2 py-4 text-center text-[10px] text-muted-foreground">{tEmpty}</div>;
  }
  return (
    <>
      <ul role="tree" className="space-y-px">
        {state.results.map((r) => {
          const isSelected = selectedSet.has(r.path);
          if (r.type === 'dir') {
            return (
              <li
                key={r.path}
                role="treeitem"
                className="flex h-[22px] items-center gap-1.5 rounded-sm px-1 text-[length:var(--ide-tree-font,11.5px)] text-muted-foreground"
                title={r.path}
              >
                <span className="w-3 shrink-0" aria-hidden="true" />
                <span className="w-3.5 shrink-0" aria-hidden="true" />
                <FolderIcon name={r.path.split('/').at(-1) ?? r.path} expanded={false} className="h-3.5 w-3.5" />
                <span className="truncate">{r.path}</span>
              </li>
            );
          }
          return (
            <li key={r.path} role="none">
              <button
                type="button"
                role="treeitem"
                aria-selected={isSelected}
                onClick={() => onToggleSelect(r.path)}
                className={cn(
                  'group flex h-[22px] w-full items-center gap-1.5 rounded-sm px-1 text-left text-[length:var(--ide-tree-font,11.5px)] transition-colors',
                  isSelected
                    ? 'bg-accent text-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
                title={r.path}
              >
                <span className="w-3 shrink-0" aria-hidden="true" />
                <SelectionMark state={isSelected ? 'all' : 'none'} />
                <FileIcon path={r.path} className="h-3.5 w-3.5" />
                <span className={cn('truncate', isSelected && 'font-medium')}>{r.path}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {state.truncated && (
        <div className="mt-1 border-t border-border/50 px-2 pt-1.5 text-[10px] italic text-muted-foreground">
          {tTruncated}
        </div>
      )}
    </>
  );
});
