import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { ensureLang, getHighlighter, type ShikiTheme } from './shiki-client.js';
import { useIsDark } from './useIsDark.js';

interface Props {
  code: string;
  lang: string;
  wrap: boolean;
  lineNumbers: boolean;
}

const MAX_HIGHLIGHT_BYTES = 500_000; // skip highlighting for huge files

export function CodeBlock({ code, lang, wrap, lineNumbers }: Props) {
  const dark = useIsDark();
  const theme: ShikiTheme = dark ? 'github-dark' : 'github-light';
  const [html, setHtml] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const tooLarge = code.length > MAX_HIGHLIGHT_BYTES;

  useEffect(() => {
    if (tooLarge) { setLoading(false); setHtml(null); return; }
    let cancelled = false;
    setLoading(true);
    (async () => {
      const resolvedLang = await ensureLang(lang);
      const hl = await getHighlighter();
      const out = hl.codeToHtml(code, {
        lang: resolvedLang,
        theme,
        transformers: [
          {
            // Tag each line with a data attribute so CSS can render the
            // gutter via ::before counter — keeps the DOM light (no
            // per-line <span> for the number) and stays copy-paste safe.
            line(node, line) {
              node.properties['data-line'] = String(line);
            },
          },
        ],
      });
      if (!cancelled) {
        setHtml(out);
        setLoading(false);
      }
    })().catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [code, lang, theme, tooLarge]);

  if (tooLarge) {
    return (
      <div className="flex-1 flex flex-col min-h-0">
        <div className="px-3 py-1 text-[10px] text-amber-500 border-b bg-amber-500/10">
          Arquivo grande — syntax highlight desativado para preservar performance.
        </div>
        <pre
          className={
            'flex-1 overflow-auto p-3 m-0 font-mono text-[11px] leading-snug ' +
            (wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre')
          }
        >
          {code}
        </pre>
      </div>
    );
  }

  if (loading || !html) {
    return (
      <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground gap-2">
        <Loader2 className="h-4 w-4 animate-spin" /> Renderizando…
      </div>
    );
  }

  return (
    <div
      className={
        'shiki-viewer flex-1 overflow-auto text-[12px] leading-[1.55] font-mono ' +
        (wrap ? 'viewer-wrap ' : '') +
        (lineNumbers ? 'viewer-lineno ' : '')
      }
      // Shiki emits <pre style="background:#..."><code>…<span style="color:#...">…
      // which is safe: no user-provided HTML enters this pipeline.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
