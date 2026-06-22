/**
 * Value-controlled Markdown editor for the Docs Studio: Edit / Preview / Split
 * modes + a formatting toolbar, Monaco for source and ResearchMarkdown (Shiki,
 * HTML disabled) for the preview. Mirrors the workspace MarkdownView modes but
 * is prop-driven (not file-bound) so the authoring editors can reuse it.
 *
 *   ┌── Edit | Preview | Split  ·  B I H « » - › ──┐
 *   │ Monaco (source)   │   prose preview           │
 *   └────────────────────────────────────────────────┘
 */
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bold, Code2, Eye, FileEdit, Heading2, Italic, LayoutPanelLeft, Link as LinkIcon, List, Quote,
} from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import { LazyMonaco } from '../LazyMonaco.js';
import { useLatest } from '../use-latest.js';
import { ResearchMarkdown } from '../../docs/research/ResearchMarkdown.js';

type Mode = 'edit' | 'preview' | 'split';
type StandaloneEditor = import('monaco-editor').editor.IStandaloneCodeEditor;
type MonacoNS = typeof import('monaco-editor');

const KEY = 'mcp-docs:md-mode:';
const HEAVY = 1024 * 1024; // Monaco bogs down past ~1MB → plain textarea

function loadMode(id: string): Mode {
  if (typeof window === 'undefined') return 'edit';
  try {
    const v = window.localStorage.getItem(KEY + id);
    if (v === 'edit' || v === 'preview' || v === 'split') return v;
  } catch { /* ignore */ }
  return 'edit';
}
function saveMode(id: string, m: Mode): void {
  try { window.localStorage.setItem(KEY + id, m); } catch { /* ignore */ }
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  /** Stable id used to remember the chosen mode per editor. */
  editorId: string;
  placeholder?: string;
}

export function MarkdownEditor({ value, onChange, onBlur, editorId, placeholder }: Props) {
  const { t } = useTranslation('apiClient');
  const [mode, setMode] = useState<Mode>(() => loadMode(editorId));
  const edRef = useRef<StandaloneEditor | null>(null);
  const monacoRef = useRef<MonacoNS | null>(null);
  const onBlurRef = useLatest(onBlur);

  const heavy = value.length > HEAVY;
  const tbDisabled = mode === 'preview' || heavy;

  const change = (next: Mode): void => {
    // Leaving an editing mode unmounts Monaco (its blur may not fire) — persist now.
    if (mode !== 'preview' && next === 'preview') onBlurRef.current?.();
    setMode(next);
    saveMode(editorId, next);
  };

  // Wrap the current selection (bold/italic/inline-code/link).
  const wrap = (before: string, after: string): void => {
    const ed = edRef.current;
    const sel = ed?.getSelection();
    const model = ed?.getModel();
    if (!ed || !sel || !model) return;
    const text = model.getValueInRange(sel);
    ed.executeEdits('md-tb', [{ range: sel, text: `${before}${text}${after}`, forceMoveMarkers: true }]);
    ed.focus();
  };

  // Prefix every selected line (heading/list/quote).
  const prefix = (p: string): void => {
    const ed = edRef.current;
    const monaco = monacoRef.current;
    const sel = ed?.getSelection();
    if (!ed || !monaco || !sel) return;
    const edits = [];
    for (let ln = sel.startLineNumber; ln <= sel.endLineNumber; ln++) {
      edits.push({ range: new monaco.Range(ln, 1, ln, 1), text: p, forceMoveMarkers: true });
    }
    ed.executeEdits('md-tb', edits);
    ed.focus();
  };

  return (
    <div className="h-full min-h-0 flex flex-col border rounded-md overflow-hidden bg-background">
      <div className="h-7 shrink-0 border-b bg-card/40 flex items-center px-1.5 gap-0.5 text-[10.5px]">
        <ModeBtn icon={FileEdit} label={t('docs.mdEdit')} active={mode === 'edit'} onClick={() => change('edit')} />
        <ModeBtn icon={Eye} label={t('docs.mdPreview')} active={mode === 'preview'} onClick={() => change('preview')} />
        <ModeBtn icon={LayoutPanelLeft} label={t('docs.mdSplit')} active={mode === 'split'} onClick={() => change('split')} />
        <span className="mx-1 h-3.5 w-px bg-border" aria-hidden />
        <TbBtn icon={Bold} title={t('docs.fmtBold')} disabled={tbDisabled} onClick={() => wrap('**', '**')} />
        <TbBtn icon={Italic} title={t('docs.fmtItalic')} disabled={tbDisabled} onClick={() => wrap('*', '*')} />
        <TbBtn icon={Heading2} title={t('docs.fmtHeading')} disabled={tbDisabled} onClick={() => prefix('## ')} />
        <TbBtn icon={LinkIcon} title={t('docs.fmtLink')} disabled={tbDisabled} onClick={() => wrap('[', '](https://)')} />
        <TbBtn icon={List} title={t('docs.fmtList')} disabled={tbDisabled} onClick={() => prefix('- ')} />
        <TbBtn icon={Code2} title={t('docs.fmtCode')} disabled={tbDisabled} onClick={() => wrap('`', '`')} />
        <TbBtn icon={Quote} title={t('docs.fmtQuote')} disabled={tbDisabled} onClick={() => prefix('> ')} />
      </div>
      <div
        className="flex-1 min-h-0 overflow-hidden grid"
        style={mode === 'split' ? { gridTemplateColumns: '1fr 1px 1fr' } : { gridTemplateColumns: '1fr' }}
      >
        {mode !== 'preview' && (
          <div className="min-w-0 min-h-0">
            {heavy ? (
              <textarea
                value={value}
                placeholder={placeholder}
                spellCheck={false}
                onChange={(e) => onChange(e.target.value)}
                onBlur={() => onBlur?.()}
                className="w-full h-full resize-none bg-background p-2 font-mono text-xs outline-none"
              />
            ) : (
              <LazyMonaco
                value={value}
                language="markdown"
                onChange={(v) => onChange(v)}
                onMount={(ed, monaco) => {
                  edRef.current = ed;
                  monacoRef.current = monaco;
                  ed.onDidBlurEditorText(() => onBlurRef.current?.());
                }}
              />
            )}
          </div>
        )}
        {mode === 'split' && <div className="border-l" aria-hidden />}
        {mode !== 'edit' && (
          <div className="min-w-0 min-h-0 overflow-y-auto px-4 py-3">
            {value.trim() ? (
              <ResearchMarkdown text={value} />
            ) : (
              <p className="text-[11px] italic text-muted-foreground">{placeholder ?? t('docs.previewEmpty')}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ModeBtn({ icon: Icon, label, active, onClick }: {
  icon: React.ComponentType<{ className?: string }>; label: string; active: boolean; onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'h-5 inline-flex items-center gap-1 px-1.5 rounded text-[10.5px] transition-colors',
        active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      <Icon className="h-3 w-3" />
      <span>{label}</span>
    </button>
  );
}

function TbBtn({ icon: Icon, title, disabled, onClick }: {
  icon: React.ComponentType<{ className?: string }>; title: string; disabled?: boolean; onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      // Keep focus in the editor so executeEdits targets the live selection.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="h-5 w-5 grid place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground transition-colors disabled:opacity-30 disabled:pointer-events-none"
    >
      <Icon className="h-3 w-3" />
    </button>
  );
}
