import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../../components/ui/badge.js';
import { Input } from '../../../components/ui/input.js';
import { useApi } from '../../../hooks/useApi.js';
import { complexityVariant, type DBFile } from '../types.js';
import { FileDetailModal } from './FileDetailModal.js';

interface FilesTabProps {
  projectId: number;
}

export function FilesTab({ projectId }: FilesTabProps) {
  const { t } = useTranslation(['projects', 'common']);
  const { data: files, loading } = useApi<DBFile[]>(`/projects/${projectId}/files`);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  if (loading) return <div className="text-muted-foreground text-sm">{t('common:actions.loading')}</div>;
  if (!files || files.length === 0) {
    return <div className="text-muted-foreground text-sm">{t('projects:files.noFiles')}</div>;
  }

  const filtered = filter ? files.filter((f) => f.path.toLowerCase().includes(filter.toLowerCase())) : files;

  return (
    <div className="space-y-3">
      {selectedFile && (
        <FileDetailModal projectId={projectId} filePath={selectedFile} onClose={() => setSelectedFile(null)} />
      )}
      <Input
        type="text"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder={t('projects:files.filterPlaceholder')}
      />
      <div className="overflow-auto max-h-[600px] rounded-lg border">
        <table className="w-full text-sm">
          <thead className="text-left text-[10px] uppercase tracking-wider text-muted-foreground bg-muted/50 sticky top-0">
            <tr>
              <th className="py-2.5 px-3">{t('projects:files.path')}</th>
              <th className="py-2.5 px-3">{t('projects:files.lang')}</th>
              <th className="py-2.5 px-3 text-right">{t('projects:files.lines')}</th>
              <th className="py-2.5 px-3">{t('projects:files.layer')}</th>
              <th className="py-2.5 px-3">{t('projects:files.complexity')}</th>
              <th className="py-2.5 px-3">{t('projects:files.flags')}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((f) => (
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
    </div>
  );
}
