/**
 * Filter toolbar for the Pipelines admin grid: search box + capability /
 * status facet chips (with counts; zero-count chips hidden) + a provider
 * Select + a "shown of total" readout + clear. State lives in
 * {@link usePipelineFilter}; this component is purely presentational.
 */
import { Search, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Input } from '../../../components/ui/input.js';
import { Button } from '../../../components/ui/button.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select.js';
import { cn } from '../../../lib/utils.js';
import { CAPABILITY_BUCKETS } from './capability-meta.js';
import type { PipelineFilterResult, StatusFilter } from './usePipelineFilter.js';

const STATUS_KEYS: Record<StatusFilter, string> = {
  configured: 'configured',
  notConfigured: 'notConfigured',
  comingSoon: 'preconfigurable',
};

function Chip({
  active,
  onClick,
  count,
  icon: Icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  count?: number;
  icon?: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] transition-colors',
        active
          ? 'bg-primary text-primary-foreground border-primary'
          : 'bg-background text-muted-foreground hover:bg-muted/50',
      )}
    >
      {Icon && <Icon className="h-3 w-3" />}
      <span>{children}</span>
      {count != null && <span className="tabular-nums opacity-70">{count}</span>}
    </button>
  );
}

export function PipelineFilterBar({ filter }: { filter: PipelineFilterResult }) {
  const { t } = useTranslation(['admin']);
  const { state, set, reset, active, shown, total, capabilityCounts, statusCounts, providerOptions } = filter;

  return (
    <div className="space-y-2 rounded-lg border bg-card/50 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={state.query}
            onChange={(e) => set('query', e.target.value)}
            placeholder={t('admin:pipelines.filter.search')}
            className="pl-8 h-8"
            spellCheck={false}
          />
        </div>
        {providerOptions.length > 0 && (
          <Select value={state.provider} onValueChange={(v) => set('provider', v)}>
            <SelectTrigger className="h-8 w-[170px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('admin:pipelines.filter.allProviders')}</SelectItem>
              {providerOptions.map((p) => (
                <SelectItem key={p} value={p}>{p}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <span className="text-[11px] tabular-nums text-muted-foreground whitespace-nowrap">
          {t('admin:pipelines.filter.count', { shown, total })}
        </span>
        {active && (
          <Button size="sm" variant="ghost" onClick={reset} className="h-7 px-2 text-[11px]">
            <X className="h-3 w-3 mr-1" />
            {t('admin:pipelines.filter.clear')}
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Chip active={state.capability === 'all'} onClick={() => set('capability', 'all')}>
          {t('admin:pipelines.filter.allCapabilities')}
        </Chip>
        {CAPABILITY_BUCKETS.filter((b) => (capabilityCounts[b.key] ?? 0) > 0).map((b) => (
          <Chip
            key={b.key}
            icon={b.icon}
            count={capabilityCounts[b.key]}
            active={state.capability === b.key}
            onClick={() => set('capability', state.capability === b.key ? 'all' : b.key)}
          >
            {t(`admin:pipelines.capability.${b.i18nKey}`)}
          </Chip>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {(['configured', 'notConfigured', 'comingSoon'] as StatusFilter[])
          .filter((s) => statusCounts[s] > 0)
          .map((s) => (
            <Chip
              key={s}
              count={statusCounts[s]}
              active={state.status === s}
              onClick={() => set('status', state.status === s ? 'all' : s)}
            >
              {t(`admin:pipelines.status.${STATUS_KEYS[s]}`)}
            </Chip>
          ))}
      </div>
    </div>
  );
}
