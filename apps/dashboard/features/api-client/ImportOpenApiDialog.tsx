/**
 * Import an OpenAPI/Swagger spec into a collection. Three ways:
 *   - pick a file from your computer (read + sent as content),
 *   - type a path relative to the project root,
 *   - leave blank to auto-detect under the project root.
 * Re-import is idempotent and preserves verified requests.
 */
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Upload, FileJson, X } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import * as api from './api.js';
import type { ImportResult } from './types.js';

interface Props {
  projectId: number;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onImported: (collectionId: number) => void;
}

export function ImportOpenApiDialog({ projectId, open, onOpenChange, onImported }: Props) {
  const { t } = useTranslation('apiClient');
  const [path, setPath] = useState('');
  const [file, setFile] = useState<{ name: string; content: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const pickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!f) return;
    setError(null);
    try { setFile({ name: f.name, content: await f.text() }); }
    catch { setError(t('importOpenapi.readFileError')); }
  };

  const run = async () => {
    setBusy(true); setError(null); setResult(null);
    try {
      const r = file
        ? await api.importOpenApiContent(projectId, file.content, file.name)
        : await api.importOpenApi(projectId, path);
      setResult(r);
      onImported(r.collectionId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{t('importOpenapi.title')}</DialogTitle></DialogHeader>

        <input ref={fileInput} type="file" accept=".yaml,.yml,.json,application/json,application/x-yaml,text/yaml" className="hidden" onChange={pickFile} />

        {file ? (
          <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
            <FileJson className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="font-mono text-xs truncate flex-1" title={file.name}>{file.name}</span>
            <button type="button" aria-label={t('importOpenapi.removeFile')} className="text-muted-foreground hover:text-foreground" onClick={() => setFile(null)}>
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <>
            <Button variant="outline" size="sm" className="w-full gap-2" onClick={() => fileInput.current?.click()}>
              <Upload className="h-3.5 w-3.5" /> {t('importOpenapi.chooseFile')}
            </Button>
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span className="h-px flex-1 bg-border" /> {t('importOpenapi.orPathSeparator')} <span className="h-px flex-1 bg-border" />
            </div>
            <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder={t('importOpenapi.pathPlaceholder')} className="h-8 text-sm font-mono" />
          </>
        )}

        {error && <div className="text-xs text-red-500">{error}</div>}
        {result && (
          <div className="text-xs text-emerald-600">
            {t('importOpenapi.resultSummary', { count: result.requestCount, created: result.created, updated: result.updated })}
            {result.specChanged && <span className="text-amber-500"> {t('importOpenapi.specChanged')}</span>}
            {!!result.stale && <span className="text-amber-500"> {t('importOpenapi.staleDropped', { count: result.stale })}</span>}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>{t('importOpenapi.close')}</Button>
          <Button size="sm" disabled={busy} onClick={run} className="gap-1">
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} {t('importOpenapi.import')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
