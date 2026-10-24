/**
 * Sidebar selector for the Diagrams workspace — lists EVERY `.drawio` file in
 * the project (wherever the agent saved it), searchable. Reuses the flat
 * `files.list` fetch the file tree uses, filtered to `.drawio`.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Search, Workflow } from 'lucide-react';
import { apiCall } from '../../../lib/api-client.js';
import { cn } from '../../../lib/utils.js';

interface DiagramFile {
  path: string;
  name: string;
  dir: string;
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}
function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(0, i) : '';
}

/** Fetch + filter all `.drawio` files in the project. Re-runs on `refreshTick`. */
export function useDiagramFiles(
  projectId: number,
  refreshTick: number,
): { files: DiagramFile[]; loading: boolean } {
  const [files, setFiles] = useState<DiagramFile[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void apiCall<Array<{ path: string }>>('files.list', { projectId })
      .then((rows) => {
        if (cancelled) return;
        setFiles(
          rows
            .map((r) => r.path)
            .filter((p) => /\.drawio$/i.test(p))
            .sort()
            .map((p) => ({ path: p, name: basename(p), dir: dirname(p) })),
        );
      })
      .catch(() => {
        if (!cancelled) setFiles([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, refreshTick]);
  return { files, loading };
}

export function DiagramList({
  files,
  selectedPath,
  onSelect,
  onCreate,
}: {
  files: DiagramFile[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
  /** Create a new blank diagram (the "+" in the list header). */
  onCreate?: () => void;
}) {
  const { t } = useTranslation(['chat']);
  const [search, setSearch] = useState('');
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? files.filter((f) => f.path.toLowerCase().includes(q)) : files;
  }, [files, search]);

  return (
    <div className="flex h-full min-h-0 flex-col border-r bg-card/30">
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b px-2">
        <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('chat:diagrams.search')}
          className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
        />
        {onCreate && (
          <button
            type="button"
            onClick={onCreate}
            title={t('chat:diagrams.new')}
            className="grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {filtered.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            {files.length === 0 ? t('chat:diagrams.empty') : t('chat:diagrams.noMatch')}
          </div>
        ) : (
          filtered.map((f) => (
            <button
              key={f.path}
              type="button"
              onClick={() => onSelect(f.path)}
              title={f.path}
              className={cn(
                'flex w-full items-center gap-2 px-2 py-1 text-left text-xs transition-colors',
                selectedPath === f.path ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
              )}
            >
              <Workflow className="h-3.5 w-3.5 shrink-0 text-violet-300" />
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium">{f.name}</span>
                {f.dir && <span className="ml-1 text-muted-foreground">{f.dir}</span>}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
