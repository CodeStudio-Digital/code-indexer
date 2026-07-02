/**
 * EnvScopeSelector — compact multi-select of session services for the
 * `service_scope` of a shared env var (D1, migration 192).
 *
 * Value model mirrors the API: `null` = every service (default), or a
 * CSV of service ids ('main' = primary container). Rendered as toggle
 * chips: an "all services" chip plus one chip per live service. Scope
 * ids that reference services no longer in the list still render (as
 * plain tokens) so stale scopes remain visible and removable.
 *
 * Used by both the AddEnvForm (EnvTab) and EnvEditDialog — keeping the
 * selector shared guarantees the two write paths agree on the format.
 */
import { useTranslation } from 'react-i18next';

export interface EnvServiceOption {
  id: string;
  label: string;
}

function parseScope(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

interface EnvScopeSelectorProps {
  services: EnvServiceOption[];
  /** CSV of service ids, or null = all services. */
  value: string | null;
  onChange: (value: string | null) => void;
}

export function EnvScopeSelector({ services, value, onChange }: EnvScopeSelectorProps) {
  const { t } = useTranslation('agents');
  const selected = parseScope(value);
  // Stale ids (scoped to a service that no longer exists) stay togglable.
  const known = new Set(services.map((s) => s.id.toLowerCase()));
  const stale = selected.filter((id) => !known.has(id));

  function toggle(id: string): void {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next.size > 0 ? Array.from(next).join(',') : null);
  }

  const chipBase =
    'px-1.5 py-0.5 rounded border text-[10px] font-mono cursor-pointer select-none transition-colors';
  const on = ' bg-primary/15 border-primary/50 text-foreground';
  const off = ' bg-background border-border text-muted-foreground hover:border-primary/30';

  return (
    <div className="space-y-1">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {t('env.scopeLabel')}
      </div>
      <div className="flex flex-wrap gap-1">
        <button
          type="button"
          className={chipBase + (selected.length === 0 ? on : off)}
          onClick={() => onChange(null)}
          title={t('env.scopeHint')}
        >
          {t('env.scopeAll')}
        </button>
        {services.map((s) => {
          const id = s.id.toLowerCase();
          return (
            <button
              key={s.id}
              type="button"
              className={chipBase + (selected.includes(id) ? on : off)}
              onClick={() => toggle(id)}
              title={s.label !== s.id ? `${s.label} (${s.id})` : s.id}
            >
              {s.id}
            </button>
          );
        })}
        {stale.map((id) => (
          <button
            key={id}
            type="button"
            className={chipBase + on}
            onClick={() => toggle(id)}
            title={t('env.scopeStale')}
          >
            {id}
          </button>
        ))}
      </div>
    </div>
  );
}
