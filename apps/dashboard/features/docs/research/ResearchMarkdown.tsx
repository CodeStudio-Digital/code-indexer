/**
 * ResearchMarkdown — renders the DocsAgent's final markdown answer with
 * GitHub-flavored markdown + syntax-highlighted fenced code blocks.
 *
 * Why a separate component (vs the chat `Markdown.tsx`)?
 *   - The chat component intentionally stays light — no Shiki, no async
 *     loaders — so streaming responses render instantly.
 *   - Research answers are LONG, frequently contain code snippets
 *     (`csharp`, `php`, `tsx`, `python`, …) that the user wants
 *     rendered properly, and arrive as a single block AFTER the run
 *     finishes — so the cost of lazy-loading languages is amortized
 *     across the whole response.
 *
 * Code highlighting reuses the existing Shiki integration in
 * `apps/dashboard/features/builder/preview/files/viewer/shiki-client.ts`
 * — same `getHighlighter()` singleton + `ensureLang()` lazy loader the
 * file viewer uses. No new npm dependency. Languages without a Shiki
 * grammar (or unknown to the user) gracefully fall back to a plain
 * `<pre>` instead of crashing.
 */
import { memo, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Copy, Check } from 'lucide-react';
import { copyText } from '../../../lib/clipboard.js';
import { cn } from '../../../lib/utils.js';
import {
  ensureLang,
  getHighlighter,
  type ShikiTheme,
} from '../../builder/preview/files/viewer/shiki-client.js';
import { useIsDark } from '../../builder/preview/files/viewer/useIsDark.js';

interface MarkdownProps {
  text: string;
  className?: string;
}

const proseClasses =
  'prose prose-sm max-w-none dark:prose-invert ' +
  // Reset prose styles around our custom <pre> so Shiki's inline colors
  // win — otherwise the prose theme overrides the syntax token colors.
  'prose-pre:p-0 prose-pre:m-0 prose-pre:bg-transparent prose-pre:border-0 ' +
  'prose-code:before:content-none prose-code:after:content-none ' +
  'prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:font-normal ' +
  'prose-code:bg-muted prose-code:text-foreground ' +
  'prose-table:text-xs prose-th:px-2 prose-td:px-2 ' +
  'prose-headings:mt-3 prose-headings:mb-1.5 prose-p:my-1.5 prose-ul:my-1.5 prose-ol:my-1.5 ' +
  // Anchor styling so footnote markers [^1] (rendered by remark-gfm as
  // <sup><a>…</a></sup>) stand out.
  'prose-a:text-primary';

export const ResearchMarkdown = memo(function ResearchMarkdown({ text, className }: MarkdownProps) {
  return (
    <div data-text-selectable className={cn(proseClasses, className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code: CodeRenderer,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

/**
 * Custom `code` renderer for `react-markdown`. React-markdown wraps both
 * inline `code` and fenced `<pre><code class="language-X">` in the same
 * component slot — we discriminate via the `className` (fenced has
 * `language-…`) and the absence of newlines (inline is single-line).
 */
interface CodeRendererProps {
  className?: string;
  children?: ReactNode;
}

function CodeRenderer({ className, children }: CodeRendererProps) {
  const raw = childrenToString(children);
  const langMatch = /language-([\w+-]+)/.exec(className ?? '');
  const lang = langMatch?.[1];

  // Inline code → no language and no newlines → render as <code>.
  if (!lang && !raw.includes('\n')) {
    return <code className={className}>{children}</code>;
  }
  // Fenced block: pass to the Shiki-driven highlighter.
  return <HighlightedBlock code={raw.replace(/\n$/, '')} lang={lang ?? 'text'} />;
}

function childrenToString(children: ReactNode): string {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(childrenToString).join('');
  if (children == null || typeof children === 'boolean') return '';
  if (typeof children === 'number') return String(children);
  // ReactNode with children — best-effort.
  const maybe = children as { props?: { children?: ReactNode } };
  if (maybe?.props?.children !== undefined) return childrenToString(maybe.props.children);
  return '';
}

interface HighlightedBlockProps {
  code: string;
  lang: string;
}

const MAX_HIGHLIGHT_BYTES = 200_000;

function HighlightedBlock({ code, lang }: HighlightedBlockProps) {
  const { t } = useTranslation('docs');
  const dark = useIsDark();
  const theme: ShikiTheme = dark ? 'github-dark' : 'github-light';
  const [html, setHtml] = useState<string | null>(null);
  const [resolvedLang, setResolvedLang] = useState<string>(lang);
  const [copied, setCopied] = useState(false);
  const tooLarge = code.length > MAX_HIGHLIGHT_BYTES;

  useEffect(() => {
    if (tooLarge) {
      setHtml(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const finalLang = await ensureLang(lang);
        const hl = await getHighlighter();
        const out = hl.codeToHtml(code, { lang: finalLang, theme });
        if (!cancelled) {
          setHtml(out);
          setResolvedLang(finalLang);
        }
      } catch {
        if (!cancelled) setHtml(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, lang, theme, tooLarge]);

  async function copy() {
    if (await copyText(code)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

  // Plain fallback while the highlighter loads OR when the language
  // failed to resolve OR the block is too big.
  if (!html || tooLarge) {
    return (
      <div className="relative my-2 rounded-md border bg-card overflow-hidden">
        <div className="flex items-center justify-between px-2 py-1 border-b text-[10px] uppercase tracking-wide text-muted-foreground">
          <span>{tooLarge ? t('research.codeLargeWarning') : (resolvedLang ?? 'text')}</span>
          <CopyButton onClick={copy} copied={copied} />
        </div>
        <pre className="p-3 overflow-auto text-[12px] leading-snug font-mono whitespace-pre">
          <code>{code}</code>
        </pre>
      </div>
    );
  }

  return (
    <div className="research-codeblock relative my-2 rounded-md border bg-card overflow-hidden">
      <div className="flex items-center justify-between px-2 py-1 border-b text-[10px] uppercase tracking-wide text-muted-foreground">
        <span>{resolvedLang}</span>
        <CopyButton onClick={copy} copied={copied} />
      </div>
      <div
        className="research-shiki overflow-auto text-[12px] leading-[1.55] font-mono [&_pre]:m-0 [&_pre]:p-3 [&_pre]:overflow-auto [&_pre]:bg-transparent"
        // Shiki emits trusted HTML (no user-provided HTML enters the
        // pipeline; the code text is rendered as text nodes inside
        // pre/code tags). Same posture as CodeBlock.tsx.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

function CopyButton({ onClick, copied }: { onClick: () => void; copied: boolean }) {
  const { t } = useTranslation('docs');
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-muted/60 text-[10px]"
      aria-label={t('research.codeCopyAriaLabel')}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? t('research.codeCopied') : t('research.codeCopy')}
    </button>
  );
}
