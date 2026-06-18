/**
 * Body tab — kind selector (7 Postman kinds) dispatching to the right sub-editor.
 * json/raw/graphql use Monaco; form-data/urlencoded use the KeyValueGrid; binary
 * takes a file path. Each kind has its own column so switching never destroys
 * another kind's content.
 */
import { Input } from '../../../components/ui/input.js';
import { KeyValueGrid } from '../kv-grid/KeyValueGrid.js';
import { parseRows, stringifyRows } from '../kv-grid/kv-utils.js';
import { JsonRawEditor } from './JsonRawEditor.js';
import type { ApiBodyKind, ApiBodyRawLang, ApiRequest, KvRow } from '../types.js';

interface Props {
  draft: ApiRequest;
  upd: (p: Partial<ApiRequest>) => void;
  persist: (p: Partial<ApiRequest>) => void;
}

const KINDS: Array<{ value: ApiBodyKind; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'json', label: 'JSON' },
  { value: 'raw', label: 'Raw' },
  { value: 'form-data', label: 'Form Data' },
  { value: 'urlencoded', label: 'x-www-form-urlencoded' },
  { value: 'graphql', label: 'GraphQL' },
  { value: 'binary', label: 'Binary' },
];
const RAW_LANGS: ApiBodyRawLang[] = ['text', 'json', 'xml', 'html', 'javascript'];
const MONACO_LANG: Record<ApiBodyRawLang, string> = { text: 'plaintext', json: 'json', xml: 'xml', html: 'html', javascript: 'javascript' };

export function BodyPanel({ draft, upd, persist }: Props) {
  const kind: ApiBodyKind = draft.body_kind === 'form' ? 'urlencoded' : draft.body_kind;

  const grid = (col: 'body_form_json' | 'body_urlencoded_json', fileRows: boolean) => (
    <KeyValueGrid
      rows={parseRows(draft[col])}
      fileRows={fileRows}
      descriptions={false}
      onChange={(rows: KvRow[]) => upd({ [col]: stringifyRows(rows) } as Partial<ApiRequest>)}
      onCommit={(rows: KvRow[]) => persist({ [col]: stringifyRows(rows) } as Partial<ApiRequest>)}
    />
  );

  return (
    <div className="flex flex-col h-full gap-2">
      <div className="flex items-center gap-2">
        <select
          className="text-xs bg-background border rounded px-2 py-1"
          value={kind}
          onChange={(e) => { const body_kind = e.target.value as ApiBodyKind; upd({ body_kind }); persist({ body_kind }); }}
        >
          {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
        </select>
        {kind === 'raw' && (
          <select
            className="text-xs bg-background border rounded px-2 py-1"
            value={draft.body_raw_lang ?? 'text'}
            onChange={(e) => { const body_raw_lang = e.target.value as ApiBodyRawLang; upd({ body_raw_lang }); persist({ body_raw_lang }); }}
          >
            {RAW_LANGS.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        )}
      </div>

      <div className="flex-1 min-h-0">
        {kind === 'none' && <div className="h-full flex items-center justify-center text-xs text-muted-foreground">This request has no body.</div>}
        {kind === 'json' && (
          <JsonRawEditor value={draft.body_json ?? ''} language="json"
            onChange={(v) => upd({ body_json: v })} onBlur={() => persist({ body_json: draft.body_json })} />
        )}
        {kind === 'raw' && (
          <JsonRawEditor value={draft.body_json ?? ''} language={MONACO_LANG[draft.body_raw_lang ?? 'text']}
            onChange={(v) => upd({ body_json: v })} onBlur={() => persist({ body_json: draft.body_json })} />
        )}
        {kind === 'form-data' && grid('body_form_json', true)}
        {kind === 'urlencoded' && grid('body_urlencoded_json', false)}
        {kind === 'graphql' && <GraphqlEditor draft={draft} upd={upd} persist={persist} />}
        {kind === 'binary' && (
          <Input
            value={draft.body_binary_path ?? ''}
            placeholder="/absolute/path/to/file"
            onChange={(e) => upd({ body_binary_path: e.target.value })}
            onBlur={() => persist({ body_binary_path: draft.body_binary_path })}
            className="h-8 text-xs font-mono"
          />
        )}
      </div>
    </div>
  );
}

function GraphqlEditor({ draft, upd, persist }: Props) {
  let parsed: { query?: string; variables?: string } = {};
  try { parsed = JSON.parse(draft.body_graphql_json ?? '{}'); } catch { /* empty */ }
  const write = (patch: { query?: string; variables?: string }, commit: boolean) => {
    const next = JSON.stringify({ query: parsed.query ?? '', variables: parsed.variables ?? '', ...patch });
    upd({ body_graphql_json: next });
    if (commit) persist({ body_graphql_json: next });
  };
  return (
    <div className="flex flex-col h-full gap-2">
      <div className="flex-1 min-h-0">
        <div className="text-[11px] text-muted-foreground mb-1">Query</div>
        <JsonRawEditor value={parsed.query ?? ''} language="graphql" showFormat={false}
          onChange={(v) => write({ query: v }, false)} onBlur={() => write({}, true)} />
      </div>
      <div className="flex-1 min-h-0">
        <div className="text-[11px] text-muted-foreground mb-1">Variables (JSON)</div>
        <JsonRawEditor value={parsed.variables ?? ''} language="json"
          onChange={(v) => write({ variables: v }, false)} onBlur={() => write({}, true)} />
      </div>
    </div>
  );
}
