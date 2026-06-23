/**
 * Endpoint doc editor: markdown description, per-parameter docs (derived from the
 * request's query+header rows), and the list of saved examples (delete only;
 * examples are CAPTURED from a real send in the API tab's response viewer).
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import { MarkdownEditor } from './MarkdownEditor.js';
import { parseRows } from '../kv-grid/kv-utils.js';
import { METHOD_COLOR } from '../collection/row-format.js';
import * as docsApi from './docs-studio-api.js';
import type { ApiRequest, ApiRequestExample } from '../types.js';

type DocPatch = { description?: string; param_docs_json?: string };

export function EndpointEditor({ projectId, request, onSaveDoc }: { projectId: number; request: ApiRequest; onSaveDoc: (rid: number, body: DocPatch) => void }) {
  const { t } = useTranslation('apiClient');
  const [desc, setDesc] = useState(request.description ?? '');
  const [docs, setDocs] = useState<Record<string, string>>(() => parseRecord(request.param_docs_json));
  useEffect(() => { setDesc(request.description ?? ''); setDocs(parseRecord(request.param_docs_json)); }, [request.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const params = useMemo(() => {
    const q = parseRows(request.query_json).filter((r) => r.enabled && r.key).map((r) => ({ in: 'query', name: r.key }));
    const h = parseRows(request.headers_json).filter((r) => r.enabled && r.key).map((r) => ({ in: 'header', name: r.key }));
    return [...q, ...h];
  }, [request.query_json, request.headers_json]);

  const setParamDoc = (key: string, value: string) => setDocs((d) => ({ ...d, [key]: value }));
  const saveParamDocs = () => onSaveDoc(request.id, { param_docs_json: JSON.stringify(docs) });

  return (
    <div className="h-full flex flex-col">
      <div className="h-8 shrink-0 px-3 flex items-center gap-2 border-b text-xs">
        <span className={cn('font-mono font-semibold', METHOD_COLOR[request.method] ?? '')}>{request.method}</span>
        <span className="font-medium truncate">{request.name}</span>
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-2 space-y-2">
        <div className="h-64"><MarkdownEditor value={desc} editorId={`endpoint:${request.id}`} placeholder={t('docs.descPlaceholder')} onChange={setDesc} onBlur={() => onSaveDoc(request.id, { description: desc })} /></div>

        {params.length > 0 && (
          <div className="border rounded-md p-3">
            <div className="text-[11px] font-medium text-muted-foreground mb-1.5">{t('docs.paramDocs')}</div>
            <div className="space-y-1.5">
              {params.map((p) => {
                const key = `${p.in}:${p.name}`;
                return (
                  <div key={key} className="flex items-center gap-2">
                    <span className="font-mono text-[11px] w-32 shrink-0 truncate" title={key}>{p.name}<span className="ml-1 text-[9px] text-muted-foreground">{p.in}</span></span>
                    <input value={docs[key] ?? ''} onChange={(e) => setParamDoc(key, e.target.value)} onBlur={saveParamDocs}
                      placeholder={t('docs.paramDocPlaceholder')} className="flex-1 text-xs bg-background border rounded px-2 py-1" />
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <ExamplesList projectId={projectId} requestId={request.id} />
      </div>
    </div>
  );
}

function ExamplesList({ projectId, requestId }: { projectId: number; requestId: number }) {
  const { t } = useTranslation('apiClient');
  const [examples, setExamples] = useState<ApiRequestExample[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    docsApi.listExamples(projectId, requestId).then((x) => { if (alive) setExamples(x); }).catch(() => { /* ignore */ });
    return () => { alive = false; };
  }, [projectId, requestId]);

  const remove = async (eid: number) => {
    await docsApi.deleteExample(projectId, requestId, eid);
    setExamples((xs) => xs.filter((x) => x.id !== eid));
  };

  return (
    <div className="border rounded-md p-3">
      <div className="text-[11px] font-medium text-muted-foreground mb-1.5">{t('docs.examples')}</div>
      {examples.length === 0 && <p className="text-[11px] text-muted-foreground italic">{t('docs.examplesHint')}</p>}
      <div className="space-y-1.5">
        {examples.map((ex) => (
          <div key={ex.id} className="border rounded text-xs">
            <div className="flex items-center gap-2 px-2 py-1">
              <button type="button" className="flex-1 text-left truncate" onClick={() => setOpen(open === ex.id ? null : ex.id)}>
                {ex.name} {ex.resp_status != null && <span className="text-muted-foreground">· {ex.resp_status}</span>}
              </button>
              {ex.redaction_count > 0 && <span className="text-[10px] text-amber-500" title={t('docs.redactedTitle')}>{t('docs.redactedBadge', { count: ex.redaction_count })}</span>}
              <button type="button" className="text-muted-foreground hover:text-red-500" onClick={() => void remove(ex.id)} title={t('docs.deleteExample')}><Trash2 className="h-3 w-3" /></button>
            </div>
            {open === ex.id && ex.resp_body && <pre className="text-[11px] font-mono whitespace-pre-wrap break-words border-t p-2 max-h-60 overflow-auto">{ex.resp_body}</pre>}
          </div>
        ))}
      </div>
    </div>
  );
}

function parseRecord(json: string | null | undefined): Record<string, string> {
  if (!json) return {};
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(o)) if (typeof v === 'string') out[k] = v;
    return out;
  } catch { return {}; }
}
