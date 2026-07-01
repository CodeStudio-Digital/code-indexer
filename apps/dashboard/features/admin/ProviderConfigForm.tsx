import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '../../components/ui/input.js';
import { Switch } from '../../components/ui/switch.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import type { ConfigField } from './types.js';

interface ProviderConfigFieldsProps {
  /** Declarative extra fields from the provider spec (`/providers/known`). */
  fields: ConfigField[];
  base_url: string;
  /** Current extra blob (per-instance config). */
  extra: Record<string, unknown>;
  onBaseUrl: (v: string) => void;
  onExtra: (key: string, v: unknown) => void;
}

/**
 * Renders a provider's declarative EXTRA settings fields (zai plan mode,
 * cloudflare account id, kimi thinking mode, openrouter attribution, …) with
 * NO per-kind code. `api_key` is handled by the parent dialog; `base_url` and
 * `extra` route here by each field's `storeIn`.
 */
export function ProviderConfigFields({ fields, base_url, extra, onBaseUrl, onExtra }: ProviderConfigFieldsProps) {
  const { t } = useTranslation('admin');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const basic = fields.filter((f) => !f.advanced);
  const advanced = fields.filter((f) => f.advanced);

  function valueOf(f: ConfigField): unknown {
    if (f.storeIn === 'base_url') return base_url;
    return extra[f.key];
  }
  function setValue(f: ConfigField, v: unknown) {
    if (f.storeIn === 'base_url') onBaseUrl(String(v ?? ''));
    else onExtra(f.key, v);
  }

  function renderField(f: ConfigField) {
    const v = valueOf(f);
    if (f.type === 'select') {
      return (
        <Select value={String(v ?? f.default ?? '')} onValueChange={(nv) => setValue(f, nv)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(f.options ?? []).map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    }
    if (f.type === 'toggle') {
      const checked = v === true || v === 'true';
      return <Switch checked={checked} onCheckedChange={(b) => setValue(f, b)} />;
    }
    return (
      <Input
        type={f.type === 'password' ? 'password' : 'text'}
        value={typeof v === 'string' ? v : ''}
        onChange={(e) => setValue(f, e.target.value)}
        placeholder={f.placeholder}
      />
    );
  }

  function fieldRow(f: ConfigField) {
    if (f.type === 'toggle') {
      return (
        <label key={f.key} className="flex items-center gap-2 text-sm">
          {renderField(f)}
          {f.label}
          {f.helpText && <span className="text-xs text-muted-foreground">— {f.helpText}</span>}
        </label>
      );
    }
    return (
      <div key={f.key}>
        <label className="text-xs font-medium">{f.label}</label>
        {renderField(f)}
        {f.helpText && <p className="mt-1 text-[11px] text-muted-foreground">{f.helpText}</p>}
      </div>
    );
  }

  if (fields.length === 0) return null;

  return (
    <>
      {basic.map(fieldRow)}
      {advanced.length > 0 && (
        <button
          type="button"
          className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          onClick={() => setShowAdvanced((s) => !s)}
        >
          {showAdvanced ? '− ' : '+ '}
          {t('admin:providerConfig.advanced', { count: advanced.length })}
        </button>
      )}
      {showAdvanced && advanced.map(fieldRow)}
    </>
  );
}
