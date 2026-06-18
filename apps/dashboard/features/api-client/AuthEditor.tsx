/**
 * Auth tab — pick a type and fill its fields. Serializes to auth_type/auth_json;
 * persists on blur. All fields accept `{{var}}`. Shows a hint when an explicit
 * Authorization header is set (explicit headers win over auth — server rule).
 */
import { Input } from '../../components/ui/input.js';
import { parseRows } from './kv-grid/kv-utils.js';
import type { ApiAuthType, ApiRequest } from './types.js';

interface Props {
  draft: ApiRequest;
  upd: (p: Partial<ApiRequest>) => void;
  persist: (p: Partial<ApiRequest>) => void;
}

type Cfg = Record<string, string>;

const TYPES: Array<{ value: ApiAuthType; label: string }> = [
  { value: 'none', label: 'No Auth' },
  { value: 'bearer', label: 'Bearer Token' },
  { value: 'basic', label: 'Basic Auth' },
  { value: 'apikey', label: 'API Key' },
  { value: 'oauth2', label: 'OAuth 2.0 (token)' },
];

export function AuthEditor({ draft, upd, persist }: Props) {
  const type: ApiAuthType = (draft.auth_type ?? 'none') as ApiAuthType;
  let cfg: Cfg = {};
  try { cfg = draft.auth_json ? JSON.parse(draft.auth_json) : {}; } catch { cfg = {}; }

  const setType = (t: ApiAuthType) => { upd({ auth_type: t }); persist({ auth_type: t }); };
  const write = (patch: Cfg, commit: boolean) => {
    const next = JSON.stringify({ ...cfg, ...patch });
    upd({ auth_json: next });
    if (commit) persist({ auth_json: next });
  };
  const field = (key: string, label: string, placeholder = '', isPw = false) => (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <Input
        type={isPw ? 'password' : 'text'}
        value={cfg[key] ?? ''}
        placeholder={placeholder}
        onChange={(e) => write({ [key]: e.target.value }, false)}
        onBlur={() => write({}, true)}
        className="h-7 text-xs font-mono"
      />
    </label>
  );

  const hasAuthHeader = parseRows(draft.headers_json).some((r) => r.enabled && r.key.toLowerCase() === 'authorization');

  return (
    <div className="flex flex-col gap-3 p-1 max-w-md">
      <label className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">Type</span>
        <select className="text-xs bg-background border rounded px-2 py-1" value={type} onChange={(e) => setType(e.target.value as ApiAuthType)}>
          {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </label>

      {type === 'bearer' && field('token', 'Token', '{{token}}')}
      {type === 'oauth2' && (<>{field('token', 'Access Token', '{{access_token}}')}{field('headerPrefix', 'Header Prefix', 'Bearer')}</>)}
      {type === 'basic' && (<>{field('username', 'Username')}{field('password', 'Password', '', true)}</>)}
      {type === 'apikey' && (
        <>
          {field('key', 'Key', 'X-Api-Key')}
          {field('value', 'Value', '{{api_key}}')}
          <label className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">Add to</span>
            <select className="text-xs bg-background border rounded px-2 py-1" value={cfg.in ?? 'header'} onChange={(e) => write({ in: e.target.value }, true)}>
              <option value="header">Header</option>
              <option value="query">Query Param</option>
            </select>
          </label>
        </>
      )}

      {type !== 'none' && hasAuthHeader && (
        <p className="text-[11px] text-amber-500">An Authorization header is set in the Headers tab and takes precedence over this auth.</p>
      )}
    </div>
  );
}
