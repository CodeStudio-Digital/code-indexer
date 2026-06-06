/**
 * Map tab — the "guide files": which files this session has changed vs only
 * read. Derived server-side from `coder_tool_calls`. Helps you (and, via
 * injection, the agent) see what's already been touched.
 */
import { useTranslation } from 'react-i18next';
import { FilePen, FileSearch } from 'lucide-react';

function FileGroup({ icon: Icon, label, paths, tone }: {
  icon: typeof FilePen;
  label: string;
  paths: string[];
  tone: string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        <Icon className={`h-3 w-3 ${tone}`} />
        {label}
        <span className="tabular-nums">({paths.length})</span>
      </div>
      {paths.length === 0 ? (
        <div className="text-[11px] text-muted-foreground/70 pl-4">—</div>
      ) : (
        <ul className="space-y-0.5">
          {paths.map((p) => (
            <li key={p} className="font-mono text-[11px] truncate pl-4" title={p}>
              {p}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function DriveMapTab({ fileMap }: { fileMap: { read: string[]; changed: string[] } }) {
  const { t } = useTranslation('chat');
  const empty = fileMap.read.length === 0 && fileMap.changed.length === 0;
  if (empty) {
    return <div className="text-xs text-muted-foreground text-center py-8">{t('drive.mapEmpty', 'No files touched yet.')}</div>;
  }
  return (
    <div className="space-y-4">
      <FileGroup icon={FilePen} label={t('drive.changed', 'Changed')} paths={fileMap.changed} tone="text-amber-500" />
      <FileGroup icon={FileSearch} label={t('drive.read', 'Read')} paths={fileMap.read} tone="text-sky-500" />
    </div>
  );
}
