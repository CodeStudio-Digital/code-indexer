import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, File as FileIcon, Folder, FolderOpen, FolderTree, Search, X } from 'lucide-react';
import { CollapsibleSection } from './CollapsibleSection.js';
import {
  useProjectFiles,
  type ProjectTreeNode,
  type SearchResult,
} from './useProjectFiles.js';
import { cn } from '../../../lib/utils.js';

interface ProjectFilesSectionProps {
  sessionId: number;
  projectId: number;
  selected: string[];
  onToggleSelect: (path: string) => void;
  onSetMany: (paths: string[], select: boolean) => void;
}

type FolderState = 'none' | 'partial' | 'all';

export function ProjectFilesSection({
  sessionId,
  projectId,
  selected,
  onToggleSelect,
  onSetMany,
}: ProjectFilesSectionProps) {
  const { t } = useTranslation('chat');
  const { root, expanded, toggleExpand, error, search, setSearch, searchState } =
    useProjectFiles(projectId);
  const selectedSet = new Set(selected);

  const folderStateOf = (folderPath: string): FolderState => {
    const prefix = `${folderPath}/`;
    return selected.some((p) => p.startsWith(prefix)) ? 'partial' : 'none';
  };

  const toggleFolder = async (folderPath: string, currentState: FolderState) => {
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
  };

  const headerExtra =
    selected.length > 0 ? (
      <span className="px-1.5 py-0.5 rounded bg-info/15 text-info text-[10px] font-medium">
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
      <div className="px-2 py-2">
        <div className="relative mb-2">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('files.search')}
            className="w-full text-xs pl-7 pr-7 py-1.5 rounded border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>

        {error && <div className="text-[11px] text-destructive px-1 py-1">{error}</div>}

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
    </CollapsibleSection>
  );
}

function TreeView({
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
    return <div className="text-[11px] text-muted-foreground px-1 py-2">{tLoading}</div>;
  }
  const children = root.children ?? [];
  if (children.length === 0) {
    return <div className="text-[11px] text-muted-foreground px-1 py-2">{tEmpty}</div>;
  }
  return (
    <ul className="space-y-0.5">
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
}

function FileNode({
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
  const padLeft = 4 + depth * 10;

  if (node.type === 'dir') {
    const folderState = folderStateOf(node.path);
    return (
      <li>
        <div
          className="w-full flex items-center gap-1 text-xs py-1 px-1 rounded hover:bg-muted/50"
          style={{ paddingLeft: padLeft }}
        >
          <button
            type="button"
            onClick={() => onToggleExpand(node)}
            className="shrink-0 text-muted-foreground"
            aria-label={isOpen ? 'Collapse' : 'Expand'}
          >
            {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </button>
          <FolderCheckbox
            state={folderState}
            onClick={() => onToggleFolder(node.path, folderState)}
          />
          <button
            type="button"
            onClick={() => onToggleExpand(node)}
            className="flex items-center gap-1 min-w-0 flex-1 text-left"
          >
            <span className="shrink-0 text-amber-600 dark:text-amber-400">
              {isOpen ? <FolderOpen className="h-3.5 w-3.5" /> : <Folder className="h-3.5 w-3.5" />}
            </span>
            <span className="truncate text-foreground" title={node.path}>
              {node.name}
            </span>
          </button>
        </div>
        {isOpen && node.children && (
          <ul className="space-y-0.5">
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
    <li>
      <label
        className={cn(
          'flex items-center gap-1.5 text-xs py-1 px-1 rounded cursor-pointer hover:bg-muted/50',
          isSelected && 'bg-info/10',
        )}
        style={{ paddingLeft: padLeft }}
        title={node.path}
      >
        <input
          type="checkbox"
          checked={isSelected}
          onChange={() => onToggleSelect(node.path)}
          className="h-3 w-3 shrink-0"
        />
        <FileIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span
          className={cn('truncate', isSelected ? 'text-foreground font-medium' : 'text-foreground')}
        >
          {node.name}
        </span>
      </label>
    </li>
  );
}

function FolderCheckbox({ state, onClick }: { state: FolderState; onClick: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'partial';
  }, [state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={state === 'all'}
      onClick={(e) => e.stopPropagation()}
      onChange={onClick}
      className="h-3 w-3 shrink-0"
    />
  );
}

function SearchResults({
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
    return <div className="text-[11px] text-muted-foreground px-1 py-2">{tLoading}</div>;
  }
  if (state.results.length === 0) {
    return <div className="text-[11px] text-muted-foreground px-1 py-2">{tEmpty}</div>;
  }
  return (
    <>
      <ul className="space-y-0.5">
        {state.results.map((r) => {
          const isSelected = selectedSet.has(r.path);
          if (r.type === 'dir') {
            return (
              <li
                key={r.path}
                className="flex items-center gap-1.5 text-xs py-1 px-1 rounded text-muted-foreground"
                title={r.path}
              >
                <Folder className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                <span className="truncate">{r.path}</span>
              </li>
            );
          }
          return (
            <li key={r.path}>
              <label
                className={cn(
                  'flex items-center gap-1.5 text-xs py-1 px-1 rounded cursor-pointer hover:bg-muted/50',
                  isSelected && 'bg-info/10',
                )}
                title={r.path}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => onToggleSelect(r.path)}
                  className="h-3 w-3 shrink-0"
                />
                <FileIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span
                  className={cn(
                    'truncate',
                    isSelected ? 'text-foreground font-medium' : 'text-foreground',
                  )}
                >
                  {r.path}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      {state.truncated && (
        <div className="text-[10px] text-muted-foreground italic mt-1 px-1">{tTruncated}</div>
      )}
    </>
  );
}
