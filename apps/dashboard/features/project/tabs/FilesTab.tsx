import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { Badge } from '../../../components/ui/badge.js';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { useApi } from '../../../hooks/useApi.js';
import { cn } from '../../../lib/utils.js';
import { complexityVariant, type DBFile } from '../types.js';
import { FileDetailModal } from './FileDetailModal.js';

/**
 * Indexed-files table for a project. The full file list comes from
 * `/api/projects/:id/files` in one shot — we paginate client-side
 * since (a) the endpoint already returns the index in one query, and
 * (b) typical projects are 100-10k files which sort/filter/page just
 * fine in memory at React-render speeds.
 *
 * Sort: click a header to sort by that column (asc → desc → reset).
 * The complexity column uses a custom rank order (LOW < MEDIUM < HIGH
 * < UNKNOWN) so "show me the dangerous files first" picks the right
 * direction; everything else is string/number compare.
 */

type SortKey = 'path' | 'language' | 'line_count' | 'layer' | 'complexity';
type SortDir = 'asc' | 'desc';

const PAGE_SIZE = 50;

// Complexity is a string with discrete tiers; sort lexicographic would
// give the wrong order (HIGH < LOW alphabetically). Map to a rank.
const COMPLEXITY_RANK: Record<string, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  UNKNOWN: 3,
};

function compareFiles(a: DBFile, b: DBFile, key: SortKey): number {
  switch (key) {
    case 'path':
      return a.path.localeCompare(b.path);
    case 'language':
      return a.language.localeCompare(b.language);
    case 'line_count':
      return a.line_count - b.line_count;
    case 'layer':
      return a.layer.localeCompare(b.layer);
    case 'complexity': {
      const ra = COMPLEXITY_RANK[a.complexity?.toUpperCase()] ?? 999;
      const rb = COMPLEXITY_RANK[b.complexity?.toUpperCase()] ?? 999;
      return ra - rb;
    }
  }
}

interface FilesTabProps {
  projectId: number;
}

export function FilesTab({ projectId }: FilesTabProps) {
  const { t } = useTranslation(['projects', 'common']);
  const { data: files, loading } = useApi<DBFile[]>(`/projects/${projectId}/files`);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [page, setPage] = useState(0);

  // Pipeline: filter → sort → page. Memoised so typing in the filter
  // box doesn't re-sort the entire array on every keystroke when
  // sort is off, and so paging is constant-time once filtered/sorted.
  const filtered = useMemo(() => {
    if (!files) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return files;
    return files.filter((f) =>
      f.path.toLowerCase().includes(q) || f.language.toLowerCase().includes(q),
    );
  }, [files, filter]);

  const sorted = useMemo(() => {
    if (!sortKey) return filtered;
    const copy = filtered.slice();
    copy.sort((a, b) => {
      const c = compareFiles(a, b, sortKey);
      return sortDir === 'asc' ? c : -c;
    });
    return copy;
  }, [filtered, sortKey, sortDir]);

  // Reset to page 0 whenever the active filter/sort changes the
  // effective row count — otherwise the user lands on an empty page.
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = sorted.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  const onHeaderClick = (key: SortKey) => {
    if (sortKey !== key) {
      setSortKey(key);
      setSortDir('asc');
    } else if (sortDir === 'asc') {
      setSortDir('desc');
    } else {
      // 3rd click resets — clearer than locking into desc forever.
      setSortKey(null);
      setSortDir('asc');
    }
    setPage(0);
  };

  if (loading) return <div className="text-muted-foreground text-sm">{t('common:actions.loading')}</div>;
  if (!files || files.length === 0) {
    return <div className="text-muted-foreground text-sm">{t('projects:files.noFiles')}</div>;
  }

  return (
    <div className="space-y-3">
      {selectedFile && (
        <FileDetailModal projectId={projectId} filePath={selectedFile} onClose={() => setSelectedFile(null)} />
      )}
      <div className="flex items-center gap-2">
        <Input
          type="text"
          value={filter}
          onChange={(e) => { setFilter(e.target.value); setPage(0); }}
          placeholder={t('projects:files.filterPlaceholder')}
          className="flex-1"
        />
        <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
          {sorted.length.toLocaleString()} / {files.length.toLocaleString()}
        </span>
      </div>
      <div className="overflow-auto max-h-[600px] rounded-lg border">
        <table className="w-full text-sm">
          <thead className="text-left text-[10px] uppercase tracking-wider text-muted-foreground bg-muted/50 sticky top-0">
            <tr>
              <SortHeader label={t('projects:files.path')}       k="path"       sortKey={sortKey} sortDir={sortDir} onClick={onHeaderClick} />
              <SortHeader label={t('projects:files.lang')}       k="language"   sortKey={sortKey} sortDir={sortDir} onClick={onHeaderClick} />
              <SortHeader label={t('projects:files.lines')}      k="line_count" sortKey={sortKey} sortDir={sortDir} onClick={onHeaderClick} align="right" />
              <SortHeader label={t('projects:files.layer')}      k="layer"      sortKey={sortKey} sortDir={sortDir} onClick={onHeaderClick} />
              <SortHeader label={t('projects:files.complexity')} k="complexity" sortKey={sortKey} sortDir={sortDir} onClick={onHeaderClick} />
              <th className="py-2.5 px-3">{t('projects:files.flags')}</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((f) => (
              <tr
                key={f.id}
                className="border-t hover:bg-accent/40 cursor-pointer transition-colors"
                onClick={() => setSelectedFile(f.path)}
              >
                <td className="py-2 px-3 font-mono text-xs text-primary">{f.path}</td>
                <td className="py-2 px-3 text-xs text-muted-foreground">{f.language}</td>
                <td className="py-2 px-3 text-right text-xs tabular-nums text-muted-foreground">
                  {f.line_count}
                </td>
                <td className="py-2 px-3">
                  <Badge variant="info">{f.layer}</Badge>
                </td>
                <td className="py-2 px-3">
                  <Badge variant={complexityVariant(f.complexity)}>{f.complexity}</Badge>
                </td>
                <td className="py-2 px-3 space-x-1">
                  {f.is_entry_point === 1 && <Badge variant="default">{t('projects:files.entry')}</Badge>}
                  {f.is_test === 1 && <Badge variant="warning">{t('projects:files.test')}</Badge>}
                  {f.is_generated === 1 && <Badge variant="muted">{t('projects:files.gen')}</Badge>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pageCount > 1 && (
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span className="tabular-nums">
            {(safePage * PAGE_SIZE + 1).toLocaleString()}–{Math.min((safePage + 1) * PAGE_SIZE, sorted.length).toLocaleString()}
            {' · '}
            <span className="opacity-70">
              {t('projects:files.pageOf', { page: safePage + 1, count: pageCount })}
            </span>
          </span>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              disabled={safePage === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              title={t('projects:files.previousPage')}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              disabled={safePage >= pageCount - 1}
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              title={t('projects:files.nextPage')}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

interface SortHeaderProps {
  label: string;
  k: SortKey;
  sortKey: SortKey | null;
  sortDir: SortDir;
  onClick: (k: SortKey) => void;
  align?: 'left' | 'right';
}

/** Clickable column header. Shows direction arrow when active. */
function SortHeader({ label, k, sortKey, sortDir, onClick, align = 'left' }: SortHeaderProps) {
  const active = sortKey === k;
  const Icon = !active ? ArrowUpDown : sortDir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th className={cn('py-2.5 px-3', align === 'right' && 'text-right')}>
      <button
        type="button"
        onClick={() => onClick(k)}
        className={cn(
          'inline-flex items-center gap-1 uppercase tracking-wider transition-colors',
          active ? 'text-foreground' : 'hover:text-foreground',
        )}
      >
        <span>{label}</span>
        <Icon className={cn('h-3 w-3', !active && 'opacity-40')} />
      </button>
    </th>
  );
}
