/**
 * Center pane: edit the active request (method, path, headers, query, body)
 * and send it. Headers/query are edited as raw JSON for now; `{{var}}`
 * templates resolve against the selected environment at send time on the
 * server. Edits persist on blur; Send always persists the draft first.
 */
import { useEffect, useState } from 'react';
import { Send, Loader2 } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Textarea } from '../../components/ui/textarea.js';
import { cn } from '../../lib/utils.js';
import { HTTP_METHODS, type ApiBodyKind, type ApiRequest } from './types.js';

interface Props {
  request: ApiRequest | null;
  baseUrl: string;
  sending: boolean;
  onSave: (rid: number, patch: Partial<ApiRequest>) => void;
  onSend: (rid: number) => void;
}

type SubTab = 'headers' | 'query' | 'body';

export function RequestEditor({ request, baseUrl, sending, onSave, onSend }: Props) {
  const [draft, setDraft] = useState<ApiRequest | null>(request);
  const [tab, setTab] = useState<SubTab>('headers');

  useEffect(() => { setDraft(request); }, [request?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!draft) {
    return <div className="h-full flex items-center justify-center text-xs text-muted-foreground">Select or create a request.</div>;
  }

  const upd = (p: Partial<ApiRequest>) => setDraft((d) => (d ? { ...d, ...p } : d));
  const persist = (p: Partial<ApiRequest>) => onSave(draft.id, p);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 p-2 border-b">
        <select
          className="text-xs font-mono font-semibold bg-background border rounded px-2 py-1"
          value={draft.method}
          onChange={(e) => { upd({ method: e.target.value }); persist({ method: e.target.value }); }}
        >
          {HTTP_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <span className="text-[10px] text-muted-foreground font-mono truncate max-w-[40%]" title={baseUrl}>{baseUrl || '{{baseUrl}}'}</span>
        <Input
          value={draft.path_template}
          onChange={(e) => upd({ path_template: e.target.value })}
          onBlur={() => persist({ path_template: draft.path_template })}
          placeholder="/path/{id}?…"
          className="h-7 text-xs font-mono flex-1"
        />
        <Button size="sm" className="h-7 gap-1" disabled={sending} onClick={() => { persist({ ...draft }); onSend(draft.id); }}>
          {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          Send
        </Button>
      </div>

      <div className="flex items-center gap-1 px-2 pt-2 text-xs">
        {(['headers', 'query', 'body'] as SubTab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn('px-2 py-1 rounded-t capitalize', tab === t ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground')}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 p-2">
        {tab === 'headers' && (
          <Textarea
            value={draft.headers_json}
            onChange={(e) => upd({ headers_json: e.target.value })}
            onBlur={() => persist({ headers_json: draft.headers_json })}
            placeholder='{ "Authorization": "Bearer {{token}}" }'
            className="h-full font-mono text-xs resize-none"
          />
        )}
        {tab === 'query' && (
          <Textarea
            value={draft.query_json}
            onChange={(e) => upd({ query_json: e.target.value })}
            onBlur={() => persist({ query_json: draft.query_json })}
            placeholder='{ "page": "1" }'
            className="h-full font-mono text-xs resize-none"
          />
        )}
        {tab === 'body' && (
          <div className="flex flex-col h-full gap-2">
            <select
              className="text-xs bg-background border rounded px-2 py-1 w-28"
              value={draft.body_kind}
              onChange={(e) => { const body_kind = e.target.value as ApiBodyKind; upd({ body_kind }); persist({ body_kind }); }}
            >
              <option value="none">No body</option>
              <option value="json">JSON</option>
              <option value="raw">Raw</option>
              <option value="form">Form</option>
            </select>
            {draft.body_kind !== 'none' && (
              <Textarea
                value={draft.body_json ?? ''}
                onChange={(e) => upd({ body_json: e.target.value })}
                onBlur={() => persist({ body_json: draft.body_json })}
                placeholder={draft.body_kind === 'json' ? '{ "key": "value" }' : 'raw body…'}
                className="flex-1 font-mono text-xs resize-none"
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
