import { isValidElement, memo, useEffect, useRef, useState, type ReactNode, type ComponentProps } from 'react';
import { Check, Copy, Maximize2, Minimize2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { RootContent } from 'hast';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import { useThrottledValue } from '../../../hooks/useThrottledValue.js';
import { copyText } from '../../../lib/clipboard.js';
import { cn } from '../../../lib/utils.js';
import { useIsDark } from '../../builder/preview/files/viewer/useIsDark.js';
import { codePreview } from './code-preview.js';
import { highlightMarkdownCode, MAX_HIGHLIGHT_CHARS } from './markdown-highlight.js';
import { LargeMarkdown } from './LargeMarkdown.js';

interface MarkdownProps {
  text: string;
  className?: string;
}

const baseClasses =
  'prose prose-sm max-w-none text-[13.5px] leading-[1.45rem] prose-pre:rounded-lg prose-pre:p-3 prose-code:before:content-none prose-code:after:content-none prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:font-normal prose-table:text-[11px] prose-th:px-1.5 prose-td:px-1.5 prose-headings:mt-4 prose-headings:mb-2 prose-p:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5';

const defaultClasses =
  'dark:prose-invert prose-pre:bg-card prose-pre:border prose-pre:text-foreground prose-code:bg-muted prose-code:text-foreground prose-a:text-primary prose-strong:text-foreground';

// Hoisted out of the render: react-markdown rebuilds its unified processor on
// every render, and fresh plugin/component literals meant a new array + object
// allocation per streamed frame on top of that. Module constants are free.
const REMARK_PLUGINS = [remarkGfm];
const MARKDOWN_COMPONENTS = { pre: CodeBlock, a: MarkdownLink };
export const LARGE_MARKDOWN_CHARS = 12_000;
const MarkdownContent = memo(function MarkdownContent({ text }: { text: string }) {
  return <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>{text}</ReactMarkdown>;
});
function renderMarkdownNode(node: RootContent) {
  return toJsxRuntime(node, { Fragment, jsx, jsxs, components: MARKDOWN_COMPONENTS,
    ignoreInvalidStyle: true, passKeys: true, passNode: true });
}

function MarkdownLink({ href, children, title }: ComponentProps<'a'>) {
  const external = /^(?:https?:|mailto:)/i.test(href ?? '');
  return <a href={href} title={title} target={external ? '_blank' : undefined}
    rel={external ? 'noopener noreferrer' : undefined}
    onClick={event => {
      if (external && href && window.electronAPI?.openExternal) {
        event.preventDefault();
        window.electronAPI.openExternal(href);
      }
    }}>{children}</a>;
}

export const Markdown = memo(function Markdown({ text, className }: MarkdownProps) {
  const fence = text.length > LARGE_MARKDOWN_CHARS ? singleFence(text) : null;
  return (
    <div data-text-selectable className={cn(baseClasses, !className && defaultClasses, className)}>
      {fence ? <CodeBlock><code className={`language-${fence.lang}`}>{fence.code}</code></CodeBlock>
        : text.length > LARGE_MARKDOWN_CHARS
        ? <LargeMarkdown text={text} renderNode={renderMarkdownNode}
          preview={<pre className="whitespace-pre-wrap break-words">{text.slice(0, 4_000)}</pre>} />
        : <MarkdownContent text={text} />}
    </div>
  );
});

/** A standalone fence needs no Markdown AST. Keep the full code for copy while
 * the existing code preview/highlight budgets bound its initial render. */
function singleFence(text: string): { lang: string; code: string } | null {
  const opening = /^(`{3,}|~{3,})([^\n]*)\r?\n/.exec(text);
  if (!opening || (opening[1][0] === '`' && opening[2].includes('`'))) return null;
  const body = text.slice(opening[0].length);
  const closing = new RegExp(`(?:^|\\n) {0,3}${opening[1][0]}{${opening[1].length},}[\\t ]*(?:\\r?\\n|$)`).exec(body);
  if (closing && body.slice(closing.index + closing[0].length).trim()) return null;
  return { lang: opening[2].trim().split(/\s+/)[0] || 'text',
    code: closing ? body.slice(0, closing.index + (closing[0].startsWith('\n') ? 1 : 0)) : body };
}


/** Render fenced and indented code with syntax highlighting and per-block copy. */
function CodeBlock({ children }: { children?: ReactNode }) {
  const { t } = useTranslation('chat');
  const { code, lang } = codeBlockDetails(children);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const preview = codePreview(code);
  const collapsible = preview.truncated;
  const collapsed = collapsible && !expanded;

  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
  }, []);

  async function handleCopy() {
    if (!(await copyText(code))) return;
    setCopied(true);
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => {
      setCopied(false);
      resetTimer.current = null;
    }, 1500);
  }

  return (
    <div className="not-prose relative my-2 overflow-hidden rounded-md border bg-card text-foreground">
      <div className="flex items-center justify-between border-b bg-muted/30 px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        <span>{lang}</span>
        <div className="flex items-center gap-1">
          {collapsible && (
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 normal-case transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              aria-expanded={expanded}
              data-code-expand
            >
              {expanded ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
              <span>{expanded ? t('dbQuery.collapse') : t('dbQuery.expand')}</span>
            </button>
          )}
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 normal-case transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            aria-label={copied ? t('messages.codeCopied') : t('messages.copyCode')}
            title={copied ? t('messages.codeCopied') : t('messages.copyCode')}
            data-code-copy
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            <span>{copied ? t('messages.copied') : t('messages.copyCode')}</span>
          </button>
        </div>
      </div>
      <div className={cn('relative', collapsed && 'max-h-80 overflow-hidden')}>
        <HighlightedCode code={collapsed ? preview.text : code} lang={lang} />
        {collapsed && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-card to-transparent"
          />
        )}
      </div>
    </div>
  );
}

/** A code fence inside a streaming answer grows token by token. Re-tokenizing
 *  the whole fence on every frame was the single most expensive thing in the
 *  transcript, so the highlight input is rate-limited; the trailing commit
 *  still highlights the final, complete code. */
const HIGHLIGHT_INTERVAL_MS = 250;

/** Highlight output paired with the exact source it was produced from, so a
 *  render can tell whether the markup still describes the code on screen. */
interface Highlight {
  source: string;
  html: string;
}

function HighlightedCode({ code, lang }: { code: string; lang: string }) {
  const dark = useIsDark();
  const theme = dark ? 'github-dark' : 'github-light';
  const [highlight, setHighlight] = useState<Highlight | null>(null);
  const throttledCode = useThrottledValue(code, HIGHLIGHT_INTERVAL_MS);
  const tooLarge = code.length > MAX_HIGHLIGHT_CHARS;

  useEffect(() => {
    if (tooLarge || lang === 'text') {
      setHighlight(null);
      return;
    }
    const controller = new AbortController();
    // Deliberately NOT clearing the previous highlight here. Dropping to the
    // plain <pre> while the next one computed made every streamed frame flash
    // unstyled and forced two renders per update; the guard below decides
    // whether the existing markup is still safe to show.
    void (async () => {
      try {
        // The highlighter is initialized only for language-tagged code fences,
        // keeping ordinary streaming messages on the lightweight path.
        const html = await highlightMarkdownCode(throttledCode, lang, theme, controller.signal);
        if (!controller.signal.aborted) setHighlight(html === null ? null : { source: throttledCode, html });
      } catch {
        if (!controller.signal.aborted) setHighlight(null);
      }
    })();
    return () => {
      controller.abort();
    };
  }, [throttledCode, lang, theme, tooLarge]);

  // A streaming fence only ever grows, so markup built from a PREFIX of the
  // current code is safe to keep on screen — it simply trails the newest tokens
  // by up to one throttle window, which reads as normal streaming and avoids
  // the plain/highlighted flicker. Anything else (the component reused for a
  // different fence, or an edited block) is stale and must fall back to the
  // plain <pre>, which always shows the exact current text.
  const usable = !tooLarge && highlight && code.startsWith(highlight.source);
  if (!usable) {
    return (
      <pre className="m-0 overflow-auto p-3 font-mono text-[12px] leading-5 whitespace-pre">
        <code>{code}</code>
      </pre>
    );
  }

  return (
    <div
      className="overflow-auto font-mono text-[12px] leading-5 [&_pre]:m-0 [&_pre]:min-w-full [&_pre]:p-3"
      // Shiki creates this HTML from the code text itself, escaping user input
      // while adding syntax-token spans and theme colors.
      dangerouslySetInnerHTML={{ __html: highlight.html }}
    />
  );
}

function codeBlockDetails(children: ReactNode): { code: string; lang: string } {
  const child = Array.isArray(children) && children.length === 1 ? children[0] : children;
  if (isValidElement(child)) {
    const props = child.props as { className?: string; children?: ReactNode };
    const language = /(?:^|\s)language-([^\s]+)/.exec(props.className ?? '')?.[1]?.toLowerCase();
    return {
      code: childrenToString(props.children).replace(/\n$/, ''),
      lang: language ?? 'text',
    };
  }
  return { code: childrenToString(children).replace(/\n$/, ''), lang: 'text' };
}

function childrenToString(children: ReactNode): string {
  if (typeof children === 'string') return children;
  if (typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(childrenToString).join('');
  if (children == null || typeof children === 'boolean') return '';
  const child = children as { props?: { children?: ReactNode } };
  return child.props?.children === undefined ? '' : childrenToString(child.props.children);
}
