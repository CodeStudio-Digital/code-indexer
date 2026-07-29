import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { workspaceApi, type FileReadResponse } from '../api.js';
import { CodeBlock } from './viewer/CodeBlock.js';
import { ViewerToolbar } from './viewer/ViewerToolbar.js';
import { MarkdownView } from './viewer/MarkdownView.js';
import { useViewerPrefs } from './viewer/useViewerPrefs.js';
import { isMarkdown, langFromPath } from './viewer/language.js';

interface Props {
  sessionId: string;
  projectId: number;
  path: string | null;
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileViewer({ sessionId, projectId, path }: Props) {
  const [data, setData] = useState<FileReadResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prefs, setPrefs] = useViewerPrefs();

  useEffect(() => {
    if (!path) { setData(null); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    workspaceApi
      .file(sessionId, projectId, path)
      .then((r) => { if (!cancelled) setData(r); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sessionId, projectId, path]);

  if (!path) {
    return (
      <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
        Selecione um arquivo na árvore
      </div>
    );
  }
  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground gap-2">
        <Loader2 className="h-4 w-4 animate-spin" /> Carregando…
      </div>
    );
  }
  if (error) {
    return <div className="p-3 text-xs text-destructive">{error}</div>;
  }
  if (!data) return null;

  const markdownCapable = !data.isBinary && isMarkdown(path);
  const renderAsMarkdown = markdownCapable && prefs.renderMarkdown;
  const lang = langFromPath(path);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-3 py-1.5 border-b text-[11px] text-muted-foreground flex items-center gap-2 shrink-0">
        <span className="font-mono truncate flex-1" title={path}>{path}</span>
        <span className="uppercase tracking-wide text-[9px] px-1.5 py-0.5 rounded bg-muted">{lang}</span>
        <span>{formatSize(data.size)}</span>
        {data.truncated && <span className="text-amber-500">truncado</span>}
        {data.isBinary && <span>(binário)</span>}
      </div>
      {!data.isBinary && (
        <ViewerToolbar
          code={data.content}
          prefs={prefs}
          setPrefs={setPrefs}
          markdownCapable={markdownCapable}
        />
      )}
      {data.isBinary ? (
        <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
          Arquivo binário — preview indisponível
        </div>
      ) : renderAsMarkdown ? (
        <MarkdownView text={data.content} />
      ) : (
        <CodeBlock
          code={data.content}
          lang={lang}
          wrap={prefs.wrap}
          lineNumbers={prefs.lineNumbers}
        />
      )}
    </div>
  );
}
