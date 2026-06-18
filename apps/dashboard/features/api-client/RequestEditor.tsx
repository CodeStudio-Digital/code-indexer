/**
 * Center pane: edit the active request and send it. Headers/Params are key/value
 * grids (with bulk edit), Body is the multi-kind panel, plus Auth and Scripts
 * tabs. `{{var}}` resolves against the selected environment server-side at send.
 * Edits persist on blur; Send/Code persist the draft first.
 */
import { useEffect, useMemo, useState } from 'react';
import { Send, Loader2, Code2 } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { cn } from '../../lib/utils.js';
import { HTTP_METHODS, type ApiRequest, type KvRow } from './types.js';
import { KeyValueGrid } from './kv-grid/KeyValueGrid.js';
import { COMMON_HEADERS } from './kv-grid/header-suggestions.js';
import { parseRows, stringifyRows } from './kv-grid/kv-utils.js';
import { BodyPanel } from './body/BodyPanel.js';
import { AuthEditor } from './AuthEditor.js';
import { ScriptEditor } from './ScriptEditor.js';
import { useQuerySync, serializeQuery, stripQuery } from './useQuerySync.js';
import { SubTabs, type SubTabDef } from './SubTabs.js';

const METHOD_COLOR: Record<string, string> = {
  GET: 'text-emerald-500', POST: 'text-amber-500', PUT: 'text-blue-500',
  PATCH: 'text-violet-500', DELETE: 'text-red-500', HEAD: 'text-muted-foreground', OPTIONS: 'text-muted-foreground',
};

interface Props {
  request: ApiRequest | null;
  baseUrl: string;
  sending: boolean;
  onSave: (rid: number, patch: Partial<ApiRequest>) => void;
  onSend: (rid: number) => void;
  onOpenCode?: (rid: number) => void;
}

type SubTab = 'params' | 'headers' | 'body' | 'auth' | 'scripts';

export function RequestEditor({ request, baseUrl, sending, onSave, onSend, onOpenCode }: Props) {
  const [draft, setDraft] = useState<ApiRequest | null>(request);
  const [tab, setTab] = useState<SubTab>('params');

  useEffect(() => { setDraft(request); }, [request?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Parse the JSON columns ONCE per change (hooks must run before the early
  // return). A keystroke previously re-parsed query/headers 3-5x per render.
  const queryRows = useMemo(() => parseRows(draft?.query_json), [draft?.query_json]);
  const headerRows = useMemo(() => parseRows(draft?.headers_json), [draft?.headers_json]);
  const counts = useMemo(() => ({
    params: queryRows.filter((r) => r.key).length,
    headers: headerRows.filter((r) => r.key).length,
  }), [queryRows, headerRows]);

  if (!draft) {
    return <div className="h-full flex items-center justify-center text-xs text-muted-foreground">Select or create a request.</div>;
  }

  const d = draft;
  const upd = (p: Partial<ApiRequest>) => setDraft((prev) => (prev ? { ...prev, ...p } : prev));
  const persist = (p: Partial<ApiRequest>) => onSave(d.id, p);
  const persistUrl = () => persist({ path_template: d.path_template, query_json: d.query_json });

  const sync = useQuerySync({
    pathTemplate: d.path_template,
    queryRows,
    onPath: (p) => upd({ path_template: p }),
    onQuery: (rows: KvRow[]) => upd({ query_json: stringifyRows(rows) }),
  });

  // Persist the GIVEN query rows + a URL rebuilt from them (stripQuery normalizes
  // away the old `?…` so a stale path_template can't double the query).
  const commitQuery = (rows: KvRow[]) => {
    const qs = serializeQuery(rows);
    const base = stripQuery(d.path_template);
    persist({ query_json: stringifyRows(rows), path_template: qs ? `${base}?${qs}` : base });
  };

  const tabDefs: SubTabDef<SubTab>[] = [
    { id: 'params', label: 'Params', badge: counts.params, badgeTone: 'primary' },
    { id: 'headers', label: 'Headers', badge: counts.headers, badgeTone: 'primary' },
    { id: 'body', label: 'Body', badge: d.body_kind !== 'none' ? 1 : undefined, badgeTone: 'success' },
    { id: 'auth', label: 'Auth', badge: d.auth_type && d.auth_type !== 'none' ? 1 : undefined, badgeTone: 'success' },
    { id: 'scripts', label: 'Scripts', badge: (d.pre_request_script || d.test_script) ? 1 : undefined, badgeTone: 'success' },
  ];

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 p-2 border-b">
        <div className="flex items-center flex-1 min-w-0 h-9 border rounded-md bg-background overflow-hidden focus-within:ring-1 focus-within:ring-ring">
          <select
            className={cn('h-full text-xs font-mono font-bold bg-transparent pl-2.5 pr-1 focus:outline-none cursor-pointer', METHOD_COLOR[d.method] ?? 'text-foreground')}
            value={d.method}
            onChange={(e) => { upd({ method: e.target.value }); persist({ method: e.target.value }); }}
          >
            {HTTP_METHODS.map((m) => <option key={m} value={m} className="text-foreground">{m}</option>)}
          </select>
          <div className="w-px h-5 bg-border shrink-0" />
          {baseUrl && <span className="pl-2 text-[11px] text-muted-foreground font-mono truncate max-w-[40%] shrink-0" title={baseUrl}>{baseUrl}</span>}
          <input
            value={d.path_template}
            onChange={(e) => sync.onUrlEdit(e.target.value)}
            onBlur={persistUrl}
            placeholder="/path/{id}?q=…"
            spellCheck={false}
            className="h-full flex-1 min-w-0 bg-transparent px-2 text-xs font-mono focus:outline-none placeholder:text-muted-foreground/60"
          />
        </div>
        {onOpenCode && (
          <Button size="sm" variant="outline" className="h-9 w-9 p-0" title="Generate code (cURL, fetch, …)" onClick={async () => { await persist({ ...d }); onOpenCode(d.id); }}>
            <Code2 className="h-4 w-4" />
          </Button>
        )}
        <Button size="sm" className="h-9 gap-1.5 px-4" disabled={sending} onClick={async () => { await persist({ ...d }); onSend(d.id); }}>
          {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          Send
        </Button>
      </div>

      <SubTabs tabs={tabDefs} active={tab} onChange={setTab} className="pt-0.5" />

      <div className="flex-1 min-h-0 p-2 overflow-auto">
        {tab === 'params' && (
          <KeyValueGrid rows={queryRows} onChange={sync.onRowsEdit} onCommit={commitQuery} placeholderKey="param" />
        )}
        {tab === 'headers' && (
          <KeyValueGrid
            rows={headerRows} suggestions={COMMON_HEADERS} placeholderKey="Header-Name"
            onChange={(rows) => upd({ headers_json: stringifyRows(rows) })}
            onCommit={(rows) => persist({ headers_json: stringifyRows(rows) })}
          />
        )}
        {tab === 'body' && <BodyPanel draft={d} upd={upd} persist={persist} />}
        {tab === 'auth' && <AuthEditor draft={d} upd={upd} persist={persist} />}
        {tab === 'scripts' && <ScriptEditor draft={d} upd={upd} persist={persist} />}
      </div>
    </div>
  );
}
