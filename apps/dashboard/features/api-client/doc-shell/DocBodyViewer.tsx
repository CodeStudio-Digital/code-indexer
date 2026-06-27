/**
 * Body viewer for doc-shell examples — mirrors the API client's response body
 * toggle (Formatado · Bruto · Pré-visualização) but lightweight: no Monaco, no
 * toolbar, so the published docs site stays slim. Reuses the pure response/*
 * preview primitives (formatBody, JsonTree, preview-kind).
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../../lib/utils.js';
import { JsonTree } from '../response/JsonTree.js';
import { prettyLanguage, responsePreviewKind } from '../response/response-preview-kind.js';
import { formatBody } from '../response/format-body.js';

type Mode = 'pretty' | 'raw' | 'preview';

// Above this, format/tree freeze the main thread — default to Raw and make the
// formatted/preview panes opt-in. The full body is always available via Raw.
const HEAVY_BYTES = 512 * 1024;

export function DocBodyViewer({ body, contentType }: { body: string; contentType: string | null }) {
  const { t } = useTranslation('apiClient');
  const heavy = body.length > HEAVY_BYTES;
  const [mode, setMode] = useState<Mode>(heavy ? 'raw' : 'pretty');
  const ct = (contentType ?? '').toLowerCase();
  const lang = prettyLanguage(ct, body);
  const previewKind = responsePreviewKind(ct, body);
  // Only pay the parse + re-stringify when the Formatado pane is actually shown
  // and the body is small enough to format without jank.
  const pretty = useMemo(() => (mode === 'pretty' && !heavy ? formatBody(body, lang) : body), [mode, heavy, body, lang]);

  return (
    <div>
      <div className="flex items-center gap-1 px-2 py-1 border-b text-[11px]">
        {(['pretty', 'raw', 'preview'] as Mode[]).map((m) => (
          <button key={m} type="button" onClick={() => setMode(m)}
            className={cn('px-1.5 py-0.5 rounded', mode === m ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground')}>
            {t(`body.mode_${m}`)}
          </button>
        ))}
      </div>
      <div className="max-h-72 overflow-auto">
        {mode === 'pretty' && <pre className="text-[11px] font-mono whitespace-pre-wrap break-words p-2">{pretty}</pre>}
        {mode === 'raw' && <pre className="text-[11px] font-mono whitespace-pre-wrap break-words p-2">{body}</pre>}
        {mode === 'preview' && <DocPreview kind={previewKind} body={body} />}
      </div>
    </div>
  );
}

function DocPreview({ kind, body }: { kind: ReturnType<typeof responsePreviewKind>; body: string }) {
  const { t } = useTranslation('apiClient');
  if (kind === 'html') return <iframe sandbox="" srcDoc={body} className="w-full h-64 bg-white" title={t('body.htmlPreview')} />;
  if (kind === 'json') return <div className="p-2"><JsonTree body={body} /></div>;
  return <pre className="text-[11px] font-mono whitespace-pre-wrap break-words p-2">{body}</pre>;
}
