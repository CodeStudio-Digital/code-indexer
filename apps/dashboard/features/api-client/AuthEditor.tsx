/**
 * Auth tab — pick a type and fill its fields. Serializes to auth_type/auth_json;
 * persists on blur. All fields accept `{{var}}`. Shows a hint when an explicit
 * Authorization header is set (explicit headers win over auth — server rule).
 */
import { useTranslation } from 'react-i18next';
import { Input } from '../../components/ui/input.js';
import { parseRows } from './kv-grid/kv-utils.js';
import type { ApiAuthType, ApiRequest } from './types.js';

interface Props {
  draft: ApiRequest;
  upd: (p: Partial<ApiRequest>) => void;
  persist: (p: Partial<ApiRequest>) => void;
}

type Cfg = Record<string, string>;

const TYPES: Array<{ value: ApiAuthType; labelKey: string }> = [
  { value: 'none', labelKey: 'typeNone' },
  { value: 'bearer', labelKey: 'typeBearer' },
  { value: 'basic', labelKey: 'typeBasic' },
  { value: 'apikey', labelKey: 'typeApiKey' },
  { value: 'oauth2', labelKey: 'typeOauth2' },
];

export function AuthEditor({ draft, upd, persist }: Props) {
  const { t } = useTranslation('apiClient');
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
        <span className="text-muted-foreground">{t('auth.typeLabel')}</span>
        <select className="text-xs bg-background border rounded px-2 py-1" value={type} onChange={(e) => setType(e.target.value as ApiAuthType)}>
          {TYPES.map((opt) => <option key={opt.value} value={opt.value}>{t(`auth.${opt.labelKey}`)}</option>)}
        </select>
      </label>

      {type === 'bearer' && field('token', t('auth.token'), '{{token}}')}
      {type === 'oauth2' && (<>{field('token', t('auth.accessToken'), '{{access_token}}')}{field('headerPrefix', t('auth.headerPrefix'), 'Bearer')}</>)}
      {type === 'basic' && (<>{field('username', t('auth.username'))}{field('password', t('auth.password'), '', true)}</>)}
      {type === 'apikey' && (
        <>
          {field('key', t('auth.key'), 'X-Api-Key')}
          {field('value', t('auth.value'), '{{api_key}}')}
          <label className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">{t('auth.addTo')}</span>
            <select className="text-xs bg-background border rounded px-2 py-1" value={cfg.in ?? 'header'} onChange={(e) => write({ in: e.target.value }, true)}>
              <option value="header">{t('auth.inHeader')}</option>
              <option value="query">{t('auth.inQuery')}</option>
            </select>
          </label>
        </>
      )}

      {type !== 'none' && hasAuthHeader && (
        <p className="text-[11px] text-amber-500">{t('auth.headerPrecedenceHint')}</p>
      )}
    </div>
  );
}
