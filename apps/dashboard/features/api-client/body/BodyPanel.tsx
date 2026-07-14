/**
 * Body tab — kind selector (7 Postman kinds) dispatching to the right sub-editor.
 * json/raw/graphql use Monaco; form-data/urlencoded use the KeyValueGrid; binary
 * takes a file path. Each kind has its own column so switching never destroys
 * another kind's content.
 */
import { useTranslation } from 'react-i18next';
import { Input } from '../../../components/ui/input.js';
import { ApiClientSelect } from '../ApiClientSelect.js';
import { KeyValueGrid } from '../kv-grid/KeyValueGrid.js';
import { parseRows, stringifyRows } from '../kv-grid/kv-utils.js';
import { JsonRawEditor } from './JsonRawEditor.js';
import type { ApiBodyKind, ApiBodyRawLang, ApiRequest, KvRow } from '../types.js';

interface Props {
  draft: ApiRequest;
  upd: (p: Partial<ApiRequest>) => void;
  persist: (p: Partial<ApiRequest>) => void;
}

// `label` is a raw format/proper-noun string; `labelKey` (when present) resolves
// via t('bodyPanel.<labelKey>') at render so translatable copy is not at module scope.
const KINDS: Array<{ value: ApiBodyKind; label?: string; labelKey?: string }> = [
  { value: 'none', labelKey: 'kindNone' },
  { value: 'json', label: 'JSON' },
  { value: 'raw', labelKey: 'kindRaw' },
  { value: 'form-data', labelKey: 'kindFormData' },
  { value: 'urlencoded', label: 'x-www-form-urlencoded' },
  { value: 'graphql', label: 'GraphQL' },
  { value: 'binary', labelKey: 'kindBinary' },
];
const RAW_LANGS: ApiBodyRawLang[] = ['text', 'json', 'xml', 'html', 'javascript'];
const MONACO_LANG: Record<ApiBodyRawLang, string> = { text: 'plaintext', json: 'json', xml: 'xml', html: 'html', javascript: 'javascript' };

export function BodyPanel({ draft, upd, persist }: Props) {
  const { t } = useTranslation('apiClient');
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
        <ApiClientSelect
          value={kind}
          onValueChange={(value) => { const body_kind = value as ApiBodyKind; upd({ body_kind }); persist({ body_kind }); }}
          options={KINDS.map((option) => ({ value: option.value, label: option.labelKey ? t(`bodyPanel.${option.labelKey}`) : option.label }))}
          ariaLabel={t('request.tabBody')}
          triggerClassName="w-52"
        />
        {kind === 'raw' && (
          <ApiClientSelect
            value={draft.body_raw_lang ?? 'text'}
            onValueChange={(value) => { const body_raw_lang = value as ApiBodyRawLang; upd({ body_raw_lang }); persist({ body_raw_lang }); }}
            options={RAW_LANGS.map((language) => ({ value: language, label: language }))}
            triggerClassName="w-36 font-mono"
          />
        )}
      </div>

      <div className="flex-1 min-h-0">
        {kind === 'none' && <div className="h-full flex items-center justify-center text-xs text-muted-foreground">{t('bodyPanel.noBody')}</div>}
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
  const { t } = useTranslation('apiClient');
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
        <div className="text-[11px] text-muted-foreground mb-1">{t('bodyPanel.gqlQuery')}</div>
        <JsonRawEditor value={parsed.query ?? ''} language="graphql" showFormat={false}
          onChange={(v) => write({ query: v }, false)} onBlur={() => write({}, true)} />
      </div>
      <div className="flex-1 min-h-0">
        <div className="text-[11px] text-muted-foreground mb-1">{t('bodyPanel.gqlVariables')}</div>
        <JsonRawEditor value={parsed.variables ?? ''} language="json"
          onChange={(v) => write({ variables: v }, false)} onBlur={() => write({}, true)} />
      </div>
    </div>
  );
}
