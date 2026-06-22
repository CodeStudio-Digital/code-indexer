/**
 * Response body — Pretty (Monaco, formatted), Raw (<pre>), Preview (sandboxed
 * iframe for HTML, JsonTree for JSON, image notice for binary). Copy / save /
 * word-wrap toolbar. Truncation banner when the read cap was hit.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Download, WrapText } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { cn } from '../../../lib/utils.js';
import { LazyMonaco } from '../LazyMonaco.js';
import { JsonTree } from './JsonTree.js';
import { contentType, prettyLanguage, responsePreviewKind } from './response-preview-kind.js';
import { formatBody } from './format-body.js';
import { downloadBlob } from '../download.js';

type Mode = 'pretty' | 'raw' | 'preview';

// Above this, Monaco/format/tree freeze the main thread — default to Raw and
// make the heavy panes opt-in. The full body is always available via Save/Copy.
const HEAVY_BYTES = 512 * 1024;

interface Props {
  body: string;
  headers: Record<string, string | string[] | undefined>;
  truncated?: boolean;
}

export function ResponseBody({ body, headers, truncated }: Props) {
  const { t } = useTranslation('apiClient');
  const heavy = body.length > HEAVY_BYTES;
  const [mode, setMode] = useState<Mode>(heavy ? 'raw' : 'pretty');
  const [wrap, setWrap] = useState(!heavy);
  const ct = contentType(headers);
  const lang = prettyLanguage(ct, body);
  const previewKind = responsePreviewKind(ct, body);
  // Only pay the JSON.parse + re-stringify when the Pretty pane is actually shown
  // and the body is small enough to format without jank.
  const pretty = useMemo(() => (mode === 'pretty' && !heavy ? formatBody(body, lang) : ''), [mode, heavy, body, lang]);

  const copy = () => void navigator.clipboard?.writeText(body);
  const save = () => downloadBlob(`response.${ext(lang)}`, new Blob([body], { type: ct || 'text/plain' }));

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1 px-2 py-1 border-b text-[11px]">
        {(['pretty', 'raw', 'preview'] as Mode[]).map((m) => (
          <button key={m} onClick={() => setMode(m)}
            className={cn('px-1.5 py-0.5 rounded', mode === m ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground')}>
            {t(`body.mode_${m}`)}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-0.5">
          {mode === 'raw' && (
            <Button type="button" variant="ghost" size="icon" className={cn('h-6 w-6', wrap && 'text-primary')} title={t('body.wordWrap')} onClick={() => setWrap(!wrap)}><WrapText className="h-3.5 w-3.5" /></Button>
          )}
          <Button type="button" variant="ghost" size="icon" className="h-6 w-6" title={t('body.copy')} onClick={copy}><Copy className="h-3.5 w-3.5" /></Button>
          <Button type="button" variant="ghost" size="icon" className="h-6 w-6" title={t('body.save')} onClick={save}><Download className="h-3.5 w-3.5" /></Button>
        </div>
      </div>
      {truncated && <div className="px-2 py-1 text-[11px] text-amber-500 border-b">{t('body.truncated')}</div>}
      <div className="flex-1 min-h-0">
        {mode === 'pretty' && (heavy
          ? <TooBig body={body} />
          : <LazyMonaco value={pretty} language={lang} readOnly />)}
        {mode === 'raw' && <pre className={cn('text-xs font-mono p-2 h-full overflow-auto', wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre')}>{body}</pre>}
        {mode === 'preview' && <Preview kind={previewKind} body={body} heavy={heavy} wrap={wrap} />}
      </div>
    </div>
  );
}

function TooBig({ body }: { body: string }) {
  const { t } = useTranslation('apiClient');
  return (
    <div className="h-full flex items-center justify-center text-xs text-muted-foreground p-4 text-center">
      {t('body.tooBig', { size: (body.length / 1024 / 1024).toFixed(1) })}
    </div>
  );
}

function Preview({ kind, body, heavy, wrap }: { kind: ReturnType<typeof responsePreviewKind>; body: string; heavy: boolean; wrap: boolean }) {
  const { t } = useTranslation('apiClient');
  if (kind === 'html') return <iframe sandbox="" srcDoc={body} className="w-full h-full bg-white" title={t('body.htmlPreview')} />;
  if (kind === 'json') return heavy
    ? <TooBig body={body} />
    : <div className="p-2 overflow-auto h-full"><JsonTree body={body} /></div>;
  if (kind === 'image') return <div className="h-full flex items-center justify-center text-xs text-muted-foreground p-4 text-center">{t('body.imageNotice')}</div>;
  return <pre className={cn('text-xs font-mono p-2 h-full overflow-auto', wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre')}>{body}</pre>;
}

function ext(lang: string): string {
  return ({ json: 'json', xml: 'xml', html: 'html', javascript: 'js', plaintext: 'txt' } as Record<string, string>)[lang] ?? 'txt';
}
