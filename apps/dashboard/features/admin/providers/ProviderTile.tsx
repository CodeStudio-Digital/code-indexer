/**
 * Compact square tile that summarises a single provider in the admin
 * grid. Click anywhere on the tile opens the full provider modal
 * (`ProviderModal`) where the operator can edit / test / refresh / list
 * models — keeping the grid surface itself uncluttered.
 *
 * Visual contract:
 *
 *   ┌─────────────────────┐
 *   │ ┌────┐         [n]  │   n = total model count (badge top-right)
 *   │ │ I  │              │   I = per-kind Lucide icon, tinted square
 *   │ └────┘              │
 *   │                     │
 *   │  Provider name      │
 *   │  KIND              ★│   ★ = subtle default/status dot
 *   │  ─────────────────  │
 *   │  status chips       │
 *   └─────────────────────┘
 *
 * Status pills (default / disabled / no-key / test-pass) stay tiny so
 * the tile reads at glance without scanning. The accent stripe on the
 * left edge (border-l-2) carries the per-provider color from
 * `provider-icons` — gives the wall of tiles immediate visual rhythm
 * even before the operator reads any label.
 */
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import type { AdminProvider, TestResult } from '../types.js';
import { providerVisual } from './provider-icons.js';

interface ProviderTileProps {
  provider: AdminProvider;
  /** Total models for this provider. `null` while still loading. */
  modelCount: number | null;
  testResult: TestResult | undefined;
  onOpen: () => void;
}

export function ProviderTile({ provider: p, modelCount, testResult: tr, onOpen }: ProviderTileProps) {
  const { t } = useTranslation(['admin']);
  const { icon: Icon, fg, bg } = providerVisual(p.kind);
  const missingKey = !p.has_key && p.auth_mode === 'api_key';

  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'group relative w-[170px] h-[120px] rounded-lg border bg-card text-left overflow-hidden',
        'flex flex-col transition-all',
        'hover:border-primary/50 hover:shadow-lg hover:shadow-primary/5 hover:-translate-y-0.5',
        // Accent stripe on the left edge mirrors the provider's tint.
        // Wider on hover for a subtle "tap me" cue.
        'border-l-2',
        p.is_default ? 'border-l-primary' : 'border-l-transparent group-hover:border-l-primary/40',
        !p.enabled && 'opacity-60 grayscale',
      )}
      aria-label={`Open ${p.name} settings`}
    >
      {/* Body — icon block + meta. Padding-3 + flex-col so the chip
          row glues to the bottom of the card without absolute pos. */}
      <div className="flex-1 flex flex-col p-2.5 gap-1.5 min-h-0">
        <div className="flex items-start justify-between gap-1.5">
          <div
            className={cn(
              'h-10 w-10 rounded-md flex items-center justify-center shrink-0',
              bg,
            )}
          >
            <Icon className={cn('h-5 w-5', fg)} />
          </div>
          {/* Models count — small chip top-right. Renders `…` while
              loading so the tile doesn't shift after the first fetch. */}
          <div className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted/60 text-muted-foreground tabular-nums">
            {modelCount == null ? (
              <Loader2 className="h-2.5 w-2.5 animate-spin" />
            ) : (
              modelCount
            )}
          </div>
        </div>

        <div className="flex flex-col gap-0 min-w-0">
          <span className="text-[13px] font-semibold leading-tight truncate" title={p.name}>
            {p.name}
          </span>
          <span className="text-[9px] text-muted-foreground uppercase tracking-wider truncate">
            {p.kind}
          </span>
        </div>
      </div>

      {/* Bottom status strip — only renders chips that apply. Keeps the
          tile chrome consistent height (no jump between states). */}
      <div className="flex items-center gap-1 px-2.5 pb-2 min-h-[14px]">
        {p.is_default && (
          <span className="text-[9px] font-medium text-primary">
            {t('admin:provider.default', 'default')}
          </span>
        )}
        {!p.enabled && (
          <span className="text-[9px] text-muted-foreground">
            {t('admin:provider.disabled', 'disabled')}
          </span>
        )}
        {missingKey && (
          <span
            className="flex items-center gap-0.5 text-[9px] text-amber-600 dark:text-amber-400"
            title={t('admin:provider.noKey')}
          >
            <AlertTriangle className="h-2.5 w-2.5" />
            {t('admin:provider.noKey', 'no key')}
          </span>
        )}
        {tr?.ok === true && (
          <span
            className="flex items-center gap-0.5 text-[9px] text-emerald-600 dark:text-emerald-400 ml-auto"
            title={`${tr.latencyMs}ms`}
          >
            <CheckCircle2 className="h-2.5 w-2.5" />
            {tr.latencyMs}ms
          </span>
        )}
        {tr?.ok === false && (
          <span
            className="flex items-center gap-0.5 text-[9px] text-red-600 dark:text-red-400 ml-auto"
            title={tr.error}
          >
            <XCircle className="h-2.5 w-2.5" />
            {t('admin:provider.fail', 'fail')}
          </span>
        )}
      </div>
    </button>
  );
}
