import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfirm } from '../../components/ui/dialog-provider.js';
import { apiDelete, apiPost, useApi } from '../../hooks/useApi.js';

interface Snapshot {
  id: number;
  title: string;
  category: string;
  content: string;
  tags: string;
  created_by: string;
  created_at: string;
}

interface SnapshotVersion {
  id: number;
  snapshot_id: number;
  version: number;
  title: string;
  category: string;
  content: string;
  tags: string;
  updated_at: string;
  updated_by: string;
}

interface SnapshotEditorProps {
  projectId: number;
}

const CATEGORIES = ['architecture', 'decision', 'pattern', 'convention', 'todo', 'note'];

const CATEGORY_COLORS: Record<string, string> = {
  architecture: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  decision: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
  pattern: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  convention: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
  todo: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  note: 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200',
};

export default function SnapshotEditor({ projectId }: SnapshotEditorProps) {
  const { t } = useTranslation(['projects', 'common']);
  const confirm = useConfirm();
  const [filterCategory, setFilterCategory] = useState<string>('');
  const categoryParam = filterCategory ? `?category=${filterCategory}` : '';
  const { data: snapshots, loading, refetch } = useApi<Snapshot[]>(
    `/projects/${projectId}/snapshots${categoryParam}`,
  );
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('note');
  const [content, setContent] = useState('');
  const [tags, setTags] = useState('');
  const [historyId, setHistoryId] = useState<number | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const { data: history } = useApi<SnapshotVersion[]>(historyId ? `/snapshots/${historyId}/history` : '');

  const handleCreate = async () => {
    if (!title.trim() || !content.trim()) return;
    const tagArray = tags.trim() ? tags.split(',').map((t) => t.trim()).filter(Boolean) : [];
    await apiPost(`/projects/${projectId}/snapshots`, { title, category, content, tags: tagArray });
    setTitle('');
    setContent('');
    setTags('');
    setShowForm(false);
    refetch();
  };

  const handleDelete = async (id: number) => {
    const ok = await confirm({
      title: t('projects:snapshots.deleteConfirm'),
      description: t('projects:snapshots.deleteDescription'),
      variant: 'destructive',
      confirmLabel: t('common:actions.delete'),
    });
    if (!ok) return;
    await apiDelete(`/snapshots/${id}`);
    refetch();
  };

  if (loading) return <div className="text-gray-500">{t('common:actions.loading')}</div>;

  return (
    <div>
      <div className="flex flex-wrap justify-between items-center mb-4 gap-3">
        <h3 className="font-semibold text-gray-700 dark:text-gray-300">{t('projects:snapshots.title')}</h3>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setFilterCategory('')}
              className={`px-2 py-1 text-xs rounded ${!filterCategory ? 'bg-indigo-600 text-white' : 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600'}`}
            >
              {t('projects:snapshots.all')}
            </button>
            {CATEGORIES.map((c) => (
              <button
                key={c}
                onClick={() => setFilterCategory(filterCategory === c ? '' : c)}
                className={`px-2 py-1 text-xs rounded capitalize ${filterCategory === c ? 'bg-indigo-600 text-white' : 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600'}`}
              >
                {c}
              </button>
            ))}
          </div>
          <button
            onClick={() => setShowForm(!showForm)}
            className="px-3 py-1.5 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-700"
          >
            {showForm ? t('common:actions.cancel') : t('projects:snapshots.newSnapshot')}
          </button>
        </div>
      </div>

      {showForm && (
        <div className="mb-6 p-4 border rounded-lg dark:border-gray-700 space-y-3 bg-gray-50 dark:bg-gray-800">
          <div className="flex gap-3">
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('projects:snapshots.titlePlaceholder')}
              className="flex-1 px-3 py-2 border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
            />
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="px-3 py-2 border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={t('projects:snapshots.contentPlaceholder')}
            rows={8}
            className="w-full px-3 py-2 border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white font-mono text-sm"
          />
          <div className="flex gap-3 items-center">
            <input
              type="text"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder={t('projects:snapshots.tagsPlaceholder')}
              className="flex-1 px-3 py-2 border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white text-sm"
            />
            <button
              onClick={handleCreate}
              disabled={!title.trim() || !content.trim()}
              className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {t('projects:snapshots.saveSnapshot')}
            </button>
          </div>
        </div>
      )}

      {!snapshots || snapshots.length === 0 ? (
        <p className="text-gray-500 text-sm">
          {filterCategory ? t('projects:snapshots.noInCategory', { category: filterCategory }) : t('projects:snapshots.none')}
        </p>
      ) : (
        <div className="space-y-3">
          {snapshots.map((s) => (
            <SnapshotItem
              key={s.id}
              snapshot={s}
              history={historyId === s.id ? history ?? null : null}
              isExpanded={expandedId === s.id}
              onToggleHistory={() => setHistoryId(historyId === s.id ? null : s.id)}
              onToggleExpand={() => setExpandedId(expandedId === s.id ? null : s.id)}
              onDelete={() => handleDelete(s.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SnapshotItem({
  snapshot: s,
  history,
  isExpanded,
  onToggleHistory,
  onToggleExpand,
  onDelete,
}: {
  snapshot: Snapshot;
  history: SnapshotVersion[] | null;
  isExpanded: boolean;
  onToggleHistory: () => void;
  onToggleExpand: () => void;
  onDelete: () => void;
}) {
  let parsedTags: string[] = [];
  try {
    parsedTags = JSON.parse(s.tags);
  } catch {
    /* ignore */
  }
  const isAutoGenerated = parsedTags.includes('auto-generated');

  return (
    <div className="p-4 border rounded-lg dark:border-gray-700">
      <div className="flex justify-between items-start mb-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={`px-2 py-0.5 rounded text-xs font-medium capitalize ${CATEGORY_COLORS[s.category] ?? CATEGORY_COLORS.note}`}
          >
            {s.category}
          </span>
          <span className="font-medium dark:text-white">{s.title}</span>
          {isAutoGenerated && (
            <span className="px-1.5 py-0.5 rounded text-xs bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-200">
              auto
            </span>
          )}
          <span className="text-xs text-gray-400">
            {new Date(s.created_at).toLocaleDateString()} by {s.created_by}
          </span>
        </div>
        <div className="flex gap-2 flex-shrink-0">
          <button onClick={onToggleHistory} className="text-xs text-indigo-500 hover:text-indigo-700">
            {history ? 'Hide History' : 'History'}
          </button>
          <button onClick={onDelete} className="text-xs text-red-500 hover:text-red-700">
            Delete
          </button>
        </div>
      </div>

      {parsedTags.length > 0 && !parsedTags.every((t) => t === 'auto-generated') && (
        <div className="flex gap-1 mb-2 flex-wrap">
          {parsedTags
            .filter((t) => t !== 'auto-generated')
            .map((tag) => (
              <span
                key={tag}
                className="px-1.5 py-0.5 text-xs rounded bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400"
              >
                {tag}
              </span>
            ))}
        </div>
      )}

      <div className="text-sm text-gray-600 dark:text-gray-400 whitespace-pre-wrap font-mono">
        {isExpanded ? s.content : s.content.slice(0, 400)}
        {s.content.length > 400 && (
          <button
            onClick={onToggleExpand}
            className="ml-1 text-indigo-500 hover:text-indigo-700 font-medium font-sans"
          >
            {isExpanded ? ' [collapse]' : '... [expand]'}
          </button>
        )}
      </div>

      {history && (
        <div className="mt-3 border-t dark:border-gray-700 pt-3 space-y-2">
          <h4 className="text-xs font-semibold text-gray-500 uppercase">Version History</h4>
          {history.length === 0 ? (
            <p className="text-xs text-gray-400">No previous versions.</p>
          ) : (
            history.map((v) => (
              <details key={v.id} className="text-sm">
                <summary className="cursor-pointer text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200">
                  v{v.version} — {new Date(v.updated_at).toLocaleString()} by {v.updated_by}
                </summary>
                <div className="mt-1 p-2 bg-gray-50 dark:bg-gray-900 rounded text-xs whitespace-pre-wrap font-mono">
                  {v.content}
                </div>
              </details>
            ))
          )}
        </div>
      )}
    </div>
  );
}
