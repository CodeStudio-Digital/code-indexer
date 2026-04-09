import { useState } from 'react';
import { Badge } from '../../../components/ui/badge.js';
import { Input } from '../../../components/ui/input.js';
import { useApi } from '../../../hooks/useApi.js';
import { complexityVariant, type DBFile } from '../types.js';
import { FileDetailModal } from './FileDetailModal.js';

interface FilesTabProps {
  projectId: number;
}

export function FilesTab({ projectId }: FilesTabProps) {
  const { data: files, loading } = useApi<DBFile[]>(`/projects/${projectId}/files`);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  if (loading) return <div className="text-muted-foreground text-sm">Loading…</div>;
  if (!files || files.length === 0) {
    return <div className="text-muted-foreground text-sm">No files indexed.</div>;
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
        placeholder="Filter files…"
      />
      <div className="overflow-auto max-h-[600px] rounded-lg border">
        <table className="w-full text-sm">
          <thead className="text-left text-[10px] uppercase tracking-wider text-muted-foreground bg-muted/50 sticky top-0">
            <tr>
              <th className="py-2.5 px-3">Path</th>
              <th className="py-2.5 px-3">Lang</th>
              <th className="py-2.5 px-3 text-right">Lines</th>
              <th className="py-2.5 px-3">Layer</th>
              <th className="py-2.5 px-3">Complexity</th>
              <th className="py-2.5 px-3">Flags</th>
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
                  {f.is_entry_point === 1 && <Badge variant="default">entry</Badge>}
                  {f.is_test === 1 && <Badge variant="warning">test</Badge>}
                  {f.is_generated === 1 && <Badge variant="muted">gen</Badge>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
