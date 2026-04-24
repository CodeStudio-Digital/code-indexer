/**
 * DocsTab — renders the documentation authored by agents inside a
 * session's sandbox. Two-pane layout:
 *
 *   - Left sidebar: service picker + a navigable tree built from
 *     `docs/index.json` (authored via the `docs_index_update` tool)
 *     with a fallback that lists every `docs/**\/*.md` alphabetically
 *     when no index is present.
 *   - Main pane: the selected doc rendered as markdown (default) or raw,
 *     with a toolbar for view/raw toggle, copy, and refresh.
 *
 * Everything is read-only from the UI's perspective. Writes always go
 * through the agents' `docs_*` tools — the source of truth is the
 * sandbox filesystem, not the dashboard.
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Code2, Copy, Eye, FileText, FolderOpen, RefreshCw } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { cn } from '../../lib/utils.js';
import { Markdown } from '../chat/messages/Markdown.js';

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

interface IndexFile {
  sections?: TocEntry[];
}

function useDocsList(sessionId: number, service: string | null): {
  items: string[];
  reload: () => void;
  loading: boolean;
} {
  const [items, setItems] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const url =
      `/api/company/sessions/${sessionId}/docs/list` +
      (service ? `?service=${encodeURIComponent(service)}` : '');
    fetch(url)
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((body: { items?: string[] }) => {
        if (!cancelled) setItems(body.items ?? []);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, service, nonce]);

  return {
    items,
    loading,
    reload: () => setNonce((n) => n + 1),
  };
}

function useDocBody(sessionId: number, service: string | null, path: string | null): {
  body: string;
  loading: boolean;
} {
  const [body, setBody] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!path) {
      setBody('');
      return;
    }
    let cancelled = false;
    setLoading(true);
    const qs = new URLSearchParams({ path });
    if (service) qs.set('service', service);
    fetch(`/api/company/sessions/${sessionId}/docs/read?${qs.toString()}`)
      .then((r) => (r.ok ? r.text() : ''))
      .then((text) => {
        if (!cancelled) setBody(text);
      })
      .catch(() => {
        if (!cancelled) setBody('');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, service, path]);
  return { body, loading };
}

/**
 * Parse `docs/index.json` when present. Returns the TOC entries, or
 * `null` when the file is missing / malformed — callers then fall back
 * to the flat list.
 */
function useIndexFile(sessionId: number, service: string | null, items: string[]): {
  sections: TocEntry[] | null;
} {
  const [sections, setSections] = useState<TocEntry[] | null>(null);
  const hasIndex = items.includes('index.json');
  useEffect(() => {
    if (!hasIndex) {
      setSections(null);
      return;
    }
    let cancelled = false;
    const qs = new URLSearchParams({ path: 'index.json' });
    if (service) qs.set('service', service);
    fetch(`/api/company/sessions/${sessionId}/docs/read?${qs.toString()}`)
      .then((r) => (r.ok ? r.text() : ''))
      .then((text) => {
        if (cancelled) return;
        try {
          const parsed = JSON.parse(text) as IndexFile;
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

function TreeNode({
  entry,
  selectedPath,
  onPick,
  depth = 0,
}: {
  entry: TocEntry;
  selectedPath: string | null;
  onPick: (path: string) => void;
  depth?: number;
}) {
  const hasChildren = !!(entry.children && entry.children.length > 0);
  const isActive = entry.path && entry.path === selectedPath;
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
      </button>
      {hasChildren && (
        <div>
          {entry.children!.map((child, i) => (
            <TreeNode
              key={`${child.path ?? child.title}-${i}`}
              entry={child}
              selectedPath={selectedPath}
              onPick={onPick}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function DocsTab({ companySessionId, services = [] }: DocsTabProps) {
  const { t } = useTranslation('agents');
  const [service, setService] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'view' | 'raw'>('view');
  const [copied, setCopied] = useState(false);
  const { items, reload, loading } = useDocsList(companySessionId, service);
  const { sections } = useIndexFile(companySessionId, service, items);
  const { body, loading: bodyLoading } = useDocBody(companySessionId, service, selected);

  const flatMarkdownFiles = useMemo(
    () => items.filter((p) => p.endsWith('.md')),
    [items],
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
    navigator.clipboard.writeText(body).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
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
              />
            ))
          ) : flatMarkdownFiles.length === 0 ? (
            <div className="px-3 py-4 text-xs text-muted-foreground">
              {t('docs.noDocs')}
            </div>
          ) : (
            flatMarkdownFiles.map((path) => (
              <button
                type="button"
                key={path}
                className={
                  'w-full text-left px-3 py-1 text-xs rounded flex items-center gap-1 ' +
                  (path === selected ? 'bg-muted font-medium' : 'hover:bg-muted/50')
                }
                onClick={() => setSelected(path)}
              >
                <FileText className="h-3 w-3" />
                <span className="truncate">{path}</span>
              </button>
            ))
          )}
        </div>
      </aside>

      <main className="flex-1 flex flex-col overflow-hidden">
        {selected && (
          <div className="flex items-center gap-2 px-4 py-2 border-b bg-muted/30 shrink-0">
            <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-xs text-muted-foreground truncate flex-1 font-mono">{selected}</span>

            <div className="flex items-center gap-1 ml-auto shrink-0">
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
