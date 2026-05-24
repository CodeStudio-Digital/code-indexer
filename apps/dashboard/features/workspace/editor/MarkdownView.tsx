/**
 * Markdown viewer + edit toggle for .md / .markdown files in the editor
 * pane. Reuses react-markdown (already a dep) and the dashboard's prose
 * styles. Layout:
 *
 *   ┌──── h-7 toolbar — Edit | Preview | Split ──────┐
 *   │ ...content (Monaco when editing, prose else)  │
 *   └────────────────────────────────────────────────┘
 *
 * Split shows both side-by-side. Toggle state lives per-file so the
 * user can leave one tab in Preview while editing another.
 */

import { Suspense, lazy, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Eye, FileEdit, LayoutPanelLeft, Loader2 } from 'lucide-react';
import type { OpenFile } from '../../../state/workspace.js';
import { cn } from '../../../lib/utils.js';

const MonacoMount = lazy(() =>
  import('./MonacoMount.js').then((m) => ({ default: m.MonacoMount })),
);

type Mode = 'edit' | 'preview' | 'split';

interface MarkdownViewProps {
  file: OpenFile;
}

const STORAGE_KEY_PREFIX = 'mcp-ide:md-mode:';

function loadMode(filePath: string): Mode {
  if (typeof window === 'undefined') return 'preview';
  try {
    const v = window.localStorage.getItem(`${STORAGE_KEY_PREFIX}${filePath}`);
    if (v === 'edit' || v === 'preview' || v === 'split') return v;
  } catch {
    /* ignore */
  }
  return 'preview';
}

function saveMode(filePath: string, mode: Mode): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(`${STORAGE_KEY_PREFIX}${filePath}`, mode);
  } catch {
    /* ignore */
  }
}

export function MarkdownView({ file }: MarkdownViewProps) {
  const [mode, setMode] = useState<Mode>(() => loadMode(file.path));

  const change = (next: Mode) => {
    setMode(next);
    saveMode(file.path, next);
  };

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="h-7 shrink-0 border-b bg-card/40 flex items-center px-2 gap-0.5 text-[10.5px]">
        <ModeButton
          icon={FileEdit}
          label="Edit"
          active={mode === 'edit'}
          onClick={() => change('edit')}
        />
        <ModeButton
          icon={Eye}
          label="Preview"
          active={mode === 'preview'}
          onClick={() => change('preview')}
        />
        <ModeButton
          icon={LayoutPanelLeft}
          label="Split"
          active={mode === 'split'}
          onClick={() => change('split')}
        />
        <span className="ml-auto font-mono text-muted-foreground/70 text-[10px]">
          {file.path.split('/').pop()}
        </span>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden grid" style={gridForMode(mode)}>
        {mode !== 'preview' && (
          <Suspense
            fallback={
              <div className="grid place-items-center text-[11px] text-muted-foreground gap-1">
                <Loader2 className="h-3 w-3 animate-spin" />
                Loading editor…
              </div>
            }
          >
            <MonacoMount file={file} />
          </Suspense>
        )}
        {mode === 'split' && <div className="border-l" />}
        {mode !== 'edit' && <MarkdownRender source={file.content} />}
      </div>
    </div>
  );
}

function gridForMode(mode: Mode): React.CSSProperties {
  if (mode === 'split') {
    return { gridTemplateColumns: '1fr 1px 1fr', gridTemplateRows: '1fr' };
  }
  return { gridTemplateColumns: '1fr', gridTemplateRows: '1fr' };
}

function ModeButton({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'h-5 inline-flex items-center gap-1 px-1.5 rounded text-[10.5px] transition-colors',
        active
          ? 'bg-accent text-accent-foreground'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      <Icon className="h-3 w-3" />
      <span>{label}</span>
    </button>
  );
}

function MarkdownRender({ source }: { source: string }) {
  const components = useMemo(
    () => ({
      // Prose tweaks — Inter base, monospace for inline code, plain bg
      // for blocks since we don't have a syntax highlighter wired here.
      // Headings inherit our :root tokens from index.css.
      a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
        <a {...props} className="text-primary underline underline-offset-2 hover:text-primary/80" />
      ),
      code: (props: React.HTMLAttributes<HTMLElement> & { inline?: boolean }) => {
        if (props.inline) {
          return <code {...props} className="font-mono text-[12.5px] px-1 rounded-sm bg-muted text-foreground" />;
        }
        return <code {...props} className="font-mono text-[12px] leading-relaxed" />;
      },
      pre: (props: React.HTMLAttributes<HTMLPreElement>) => (
        <pre {...props} className="rounded-md bg-card/60 border p-3 overflow-x-auto text-[12px]" />
      ),
      table: (props: React.TableHTMLAttributes<HTMLTableElement>) => (
        <div className="overflow-x-auto">
          <table {...props} className="text-[12.5px] border-collapse w-full" />
        </div>
      ),
      th: (props: React.ThHTMLAttributes<HTMLTableCellElement>) => (
        <th {...props} className="border-b border-border px-2 py-1 text-left font-semibold" />
      ),
      td: (props: React.TdHTMLAttributes<HTMLTableCellElement>) => (
        <td {...props} className="border-b border-border/40 px-2 py-1 align-top" />
      ),
      blockquote: (props: React.BlockquoteHTMLAttributes<HTMLQuoteElement>) => (
        <blockquote
          {...props}
          className="border-l-2 border-primary/60 pl-3 italic text-muted-foreground"
        />
      ),
    }),
    [],
  );

  return (
    <div className="overflow-y-auto px-6 py-5">
      <div className="prose prose-sm dark:prose-invert max-w-3xl mx-auto prose-headings:tracking-tight prose-headings:font-semibold prose-h1:text-2xl prose-h2:text-xl prose-h3:text-base prose-p:leading-relaxed prose-li:my-0.5">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {source}
        </ReactMarkdown>
      </div>
    </div>
  );
}
