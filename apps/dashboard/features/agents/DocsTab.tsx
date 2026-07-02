/**
 * DocsTab — renders the documentation authored by agents inside a
 * session's sandbox. Two-pane layout:
 *
 *   - Left sidebar: service picker + a navigable tree built from
 *     `docs/index.json` (authored via the `docs_index_update` tool)
 *     with a fallback that lists every `docs/**\/*.md` alphabetically
 *     when no index is present.
 *   - Main pane: the selected doc rendered as markdown (default) or raw,
 *     with a toolbar for view/raw toggle, copy, refresh, provenance
 *     badge (live sandbox vs drive mirror) and the RAG index action.
 *
 * Phase D2: the backend merges sandbox docs with the durable drive
 * mirror (`__docs__/…`), so this tab keeps working after a sandbox
 * destroy — mirror-sourced docs are badged with their snapshot time.
 * Everything is read-only from the UI's perspective; writes always go
 * through the agents' `docs_*` tools.
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Code2, Copy, Database, Eye, FileText, FolderOpen, HardDrive, RefreshCw } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { copyText } from '../../lib/clipboard.js';
import { cn } from '../../lib/utils.js';
import { Markdown } from '../chat/messages/Markdown.js';
import {
  fetchDocBody,
  useDocBody,
  useDocsList,
  useDocsRag,
  type DocOrigin,
} from './docs/useCompanyDocs.js';

interface DocsTabProps {
  companySessionId: number;
  /** Optional list of secondary services so the user can target one. */
  services?: Array<{ service_id: string; name: string }>;
}

interface TocEntry {
  title: string;
  path?: string;
  children?: TocEntry[];
}

/**
 * Parse `docs/index.json` when present. Returns the TOC entries, or
 * `null` when the file is missing / malformed — callers then fall back
 * to the flat list.
 */
function useIndexFile(sessionId: number, service: string | null, hasIndex: boolean): {
  sections: TocEntry[] | null;
} {
  const [sections, setSections] = useState<TocEntry[] | null>(null);
  useEffect(() => {
    if (!hasIndex) {
      setSections(null);
      return;
    }
    let cancelled = false;
    fetchDocBody(sessionId, service, 'index.json')
      .then(({ content }) => {
        if (cancelled) return;
        try {
          const parsed = JSON.parse(content) as { sections?: TocEntry[] };
          setSections(Array.isArray(parsed.sections) ? parsed.sections : null);
        } catch {
          setSections(null);
        }
      })
      .catch(() => {
        if (!cancelled) setSections(null);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, service, hasIndex]);
  return { sections };
}

function OriginBadge({ origin, mtime }: { origin: DocOrigin | null; mtime: string | null }) {
  const { t } = useTranslation('agents');
  if (!origin) return null;
  if (origin === 'drive_mirror') {
    const stamp = mtime ? new Date(mtime).toLocaleString() : '';
    return (
      <Badge
        variant="outline"
        className="text-[10px] gap-1 shrink-0"
        title={stamp ? t('docs.mirrorTimestamp', { date: stamp }) : undefined}
      >
        <HardDrive className="h-2.5 w-2.5" />
        {t('docs.originMirror', 'mirror')}
        {stamp ? <span className="text-muted-foreground">{stamp}</span> : null}
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="text-[10px] shrink-0">
      {t('docs.originLive', 'live')}
    </Badge>
  );
}

function TreeNode({
  entry,
  selectedPath,
  onPick,
  originOf,
  depth = 0,
}: {
  entry: TocEntry;
  selectedPath: string | null;
  onPick: (path: string) => void;
  originOf: (path: string) => DocOrigin | null;
  depth?: number;
}) {
  const hasChildren = !!(entry.children && entry.children.length > 0);
  const isActive = entry.path && entry.path === selectedPath;
  const mirror = entry.path ? originOf(entry.path) === 'drive_mirror' : false;
  return (
    <div>
      <button
        type="button"
        className={
          'w-full text-left px-2 py-1 text-xs rounded flex items-center gap-1 ' +
          (isActive ? 'bg-muted font-medium' : 'hover:bg-muted/50')
        }
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => entry.path && onPick(entry.path)}
        disabled={!entry.path && !hasChildren}
      >
        {hasChildren ? <FolderOpen className="h-3 w-3" /> : <FileText className="h-3 w-3" />}
        <span className="truncate">{entry.title}</span>
        {mirror ? <HardDrive className="h-2.5 w-2.5 text-muted-foreground shrink-0" /> : null}
      </button>
      {hasChildren && (
        <div>
          {entry.children!.map((child, i) => (
            <TreeNode
              key={`${child.path ?? child.title}-${i}`}
              entry={child}
              selectedPath={selectedPath}
              onPick={onPick}
              originOf={originOf}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RagControls({ state, onIndex }: { state: ReturnType<typeof useDocsRag>['state']; onIndex: () => void }) {
  const { t } = useTranslation('agents');
  if (state === 'indexed') {
    return (
      <Badge variant="secondary" className="text-[10px] gap-1 shrink-0">
        <Database className="h-2.5 w-2.5" /> {t('docs.indexedRag', 'indexed')}
      </Badge>
    );
  }
  if (state === 'indexing') {
    return (
      <Badge variant="outline" className="text-[10px] gap-1 shrink-0">
        <RefreshCw className="h-2.5 w-2.5 animate-spin" /> {t('docs.indexingRag', 'indexing…')}
      </Badge>
    );
  }
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-6 gap-1 px-2 text-[11px]"
      onClick={onIndex}
      title={state === 'error' ? t('docs.indexRagFailed', 'RAG indexing failed — try again') : t('docs.indexRag', 'Index in RAG')}
    >
      <Database className={cn('h-3 w-3', state === 'error' && 'text-destructive')} />
      {t('docs.indexRag', 'Index in RAG')}
    </Button>
  );
}

export default function DocsTab({ companySessionId, services = [] }: DocsTabProps) {
  const { t } = useTranslation('agents');
  const [service, setService] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'view' | 'raw'>('view');
  const [copied, setCopied] = useState(false);
  const { entries, reload, loading } = useDocsList(companySessionId, service);
  const hasIndex = useMemo(() => entries.some((e) => e.path === 'index.json'), [entries]);
  const { sections } = useIndexFile(companySessionId, service, hasIndex);
  const { body, origin, mtime, loading: bodyLoading } = useDocBody(companySessionId, service, selected);
  const rag = useDocsRag(companySessionId, service, selected);

  const originByPath = useMemo(() => {
    const map = new Map<string, DocOrigin>();
    for (const e of entries) map.set(e.path, e.origin);
    return map;
  }, [entries]);
  const originOf = (path: string) => originByPath.get(path) ?? null;

  const flatMarkdownEntries = useMemo(
    () => entries.filter((e) => e.path.endsWith('.md')),
    [entries],
  );
  const flatMarkdownFiles = useMemo(
    () => flatMarkdownEntries.map((e) => e.path),
    [flatMarkdownEntries],
  );

  useEffect(() => {
    // Auto-select first available doc when nothing's selected.
    if (!selected && flatMarkdownFiles.length > 0) {
      setSelected(flatMarkdownFiles[0]!);
    }
    // If the selected doc disappeared from the listing (deleted by an
    // agent), clear it so we don't show a stale 404.
    if (selected && !flatMarkdownFiles.includes(selected)) {
      setSelected(flatMarkdownFiles[0] ?? null);
    }
  }, [flatMarkdownFiles, selected]);

  function handleCopy() {
    void copyText(body).then((ok) => {
      if (ok) {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }
    });
  }

  return (
    <div className="flex h-full overflow-hidden">
      <aside className="w-64 border-r flex flex-col bg-background">
        {services.length > 0 && (
          <div className="p-2 border-b">
            <select
              className="text-xs bg-background border rounded px-1 py-0.5 w-full"
              value={service ?? ''}
              onChange={(e) => setService(e.target.value || null)}
            >
              <option value="">{t('docs.primary')}</option>
              {services.map((s) => (
                <option key={s.service_id} value={s.service_id}>
                  {s.name || s.service_id}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="flex-1 overflow-y-auto py-1">
          {sections && sections.length > 0 ? (
            sections.map((s, i) => (
              <TreeNode
                key={`${s.path ?? s.title}-${i}`}
                entry={s}
                selectedPath={selected}
                onPick={setSelected}
                originOf={originOf}
              />
            ))
          ) : flatMarkdownEntries.length === 0 ? (
            <div className="px-3 py-4 text-xs text-muted-foreground">
              {t('docs.noDocs')}
            </div>
          ) : (
            flatMarkdownEntries.map((entry) => (
              <button
                type="button"
                key={entry.path}
                className={
                  'w-full text-left px-3 py-1 text-xs rounded flex items-center gap-1 ' +
                  (entry.path === selected ? 'bg-muted font-medium' : 'hover:bg-muted/50')
                }
                onClick={() => setSelected(entry.path)}
                title={entry.origin === 'drive_mirror' ? t('docs.originMirror', 'mirror') : undefined}
              >
                <FileText className="h-3 w-3" />
                <span className="truncate flex-1">{entry.path}</span>
                {entry.origin === 'drive_mirror' ? (
                  <HardDrive className="h-2.5 w-2.5 text-muted-foreground shrink-0" />
                ) : null}
              </button>
            ))
          )}
        </div>
      </aside>

      <main className="flex-1 flex flex-col overflow-hidden">
        {selected && (
          <div className="flex items-center gap-2 px-4 py-2 border-b bg-muted/30 shrink-0">
            <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-xs text-muted-foreground truncate font-mono">{selected}</span>
            <OriginBadge origin={origin} mtime={mtime} />

            <div className="flex items-center gap-1 ml-auto shrink-0">
              <RagControls state={rag.state} onIndex={rag.index} />

              <div className="flex items-center border rounded-md overflow-hidden text-xs">
                <button
                  type="button"
                  className={cn(
                    'px-2 py-1 flex items-center gap-1',
                    viewMode === 'view' ? 'bg-muted font-medium' : 'hover:bg-muted/50',
                  )}
                  onClick={() => setViewMode('view')}
                >
                  <Eye className="h-3 w-3" /> {t('docs.view')}
                </button>
                <button
                  type="button"
                  className={cn(
                    'px-2 py-1 flex items-center gap-1 border-l',
                    viewMode === 'raw' ? 'bg-muted font-medium' : 'hover:bg-muted/50',
                  )}
                  onClick={() => setViewMode('raw')}
                >
                  <Code2 className="h-3 w-3" /> {t('docs.raw')}
                </button>
              </div>

              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={handleCopy}
                title={t('docs.copyMarkdown')}
              >
                {copied ? (
                  <Check className="h-3 w-3 text-green-500" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
              </Button>

              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={reload}
                title={t('docs.reloadDocs')}
              >
                <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
              </Button>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {bodyLoading ? (
            <div className="p-6 text-xs text-muted-foreground">{t('docs.loading')}</div>
          ) : selected ? (
            viewMode === 'view' ? (
              <div className="p-6">
                <Markdown text={body || ''} />
              </div>
            ) : (
              <pre className="p-6 whitespace-pre-wrap text-sm font-mono leading-relaxed">
                {body || t('docs.emptyFile')}
              </pre>
            )
          ) : (
            <div className="p-6 text-sm text-muted-foreground">
              {t('docs.selectDoc')}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
