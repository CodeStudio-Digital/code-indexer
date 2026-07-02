/**
 * DocsMirrorSection — collapsed-by-default block at the bottom of the
 * Drive panel's file list showing the `__docs__/…` rows: the durable
 * mirror the agents' `docs_write` tool maintains for each service's
 * documentation.
 *
 * Read-only on purpose: no delete / upload here — the mirror is managed
 * exclusively by the docs tools, and the proper browsing surface is the
 * Docs tab (the header offers a one-click jump there). Rows still open
 * in the Drive viewer for a quick peek.
 */
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { BookOpen, ChevronDown, ChevronRight, ExternalLink, FileText } from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import { formatBytes, type DriveMirrorFile } from './driveTree.js';

interface DocsMirrorSectionProps {
  files: DriveMirrorFile[];
  selectedPath: string | null;
  /** Open a file in the Drive viewer (full drive path, prefix included). */
  onOpen: (path: string) => void;
}

/**
 * Company URLs look like `/company/sessions/:rootId/:front/:zone/:tab`.
 * Swap the trailing zone/tab for `build/docs` — done via the URL (not a
 * store) so it works no matter where the panel is hosted.
 */
function docsTabUrl(pathname: string): string | null {
  const m = pathname.match(/^(.*)\/(work|build|data)\/[^/]+\/?$/);
  return m ? `${m[1]}/build/docs` : null;
}

export function DocsMirrorSection({ files, selectedPath, onOpen }: DocsMirrorSectionProps) {
  const { t } = useTranslation('agents');
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);

  if (files.length === 0) return null;
  const docsUrl = docsTabUrl(location.pathname);

  return (
    <div className="border-t">
      <div className="flex items-center gap-1 px-1.5 py-1">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground"
          title={t('drive.docsMirrorHint', 'Read-only mirror of the service docs — manage them in the Docs tab.')}
        >
          {open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
          <BookOpen className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate font-medium">
            {t('drive.docsMirror', 'Documentation (mirror)')}
          </span>
          <span className="text-[10px]">({files.length})</span>
        </button>
        {docsUrl ? (
          <button
            type="button"
            onClick={() => navigate(docsUrl)}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted/50 hover:text-foreground"
            title={t('drive.openInDocs', 'Open in Docs tab')}
          >
            <ExternalLink className="h-3 w-3" />
            {t('drive.openInDocs', 'Open in Docs tab')}
          </button>
        ) : null}
      </div>

      {open ? (
        <ul className="pb-1">
          {files.map(({ displayPath, file }) => (
            <li key={file.path}>
              <button
                type="button"
                onClick={() => onOpen(file.path)}
                className={cn(
                  'flex w-full items-center gap-1.5 px-3 py-1 text-left text-xs',
                  selectedPath === file.path ? 'bg-muted font-medium' : 'hover:bg-muted/50',
                )}
                title={displayPath}
              >
                <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono">{displayPath}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {formatBytes(file.sizeBytes)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
