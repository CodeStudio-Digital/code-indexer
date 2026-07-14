/**
 * Auth tab — pick a type and fill its fields. Serializes to auth_type/auth_json;
 * persists on blur. All fields accept `{{var}}`. Shows a hint when an explicit
 * Authorization header is set (explicit headers win over auth — server rule).
 */
import { useTranslation } from 'react-i18next';
import { Input } from '../../components/ui/input.js';
import { ApiClientSelect } from './ApiClientSelect.js';
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
        <ApiClientSelect
          value={type}
          onValueChange={(value) => setType(value as ApiAuthType)}
          options={TYPES.map((option) => ({ value: option.value, label: t(`auth.${option.labelKey}`) }))}
          ariaLabel={t('auth.typeLabel')}
          triggerClassName="w-44"
        />
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
            <ApiClientSelect
              value={cfg.in ?? 'header'}
              onValueChange={(value) => write({ in: value }, true)}
              options={[
                { value: 'header', label: t('auth.inHeader') },
                { value: 'query', label: t('auth.inQuery') },
              ]}
              ariaLabel={t('auth.addTo')}
              triggerClassName="w-36"
            />
          </label>
        </>
      )}

      {type !== 'none' && hasAuthHeader && (
        <p className="text-[11px] text-amber-500">{t('auth.headerPrecedenceHint')}</p>
      )}
    </div>
  );
}
