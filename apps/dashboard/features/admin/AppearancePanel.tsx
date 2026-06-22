/**
 * AppearancePanel — interface preferences that live on the client (not env vars).
 * Currently the IDE density (compact / comfortable / large), which drives the
 * base UI, the file explorer and the Monaco editor via state/ui-density.ts.
 * Re-homed here from the old top-bar "Aa" button.
 */
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/utils.js';
import { useUiDensity, type Density } from '../../state/ui-density.js';

const DENSITIES: readonly Density[] = ['compact', 'comfortable', 'large'];

export function AppearancePanel() {
  const { t } = useTranslation('admin');
  const density = useUiDensity((s) => s.density);
  const setDensity = useUiDensity((s) => s.setDensity);

  return (
    <div className="max-w-md space-y-4">
      <div>
        <h2 className="text-lg font-semibold">{t('appearance.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('appearance.subtitle')}</p>
      </div>

      <section className="space-y-2 rounded-md border p-4">
        <h3 className="text-sm font-medium">{t('appearance.density')}</h3>
        <div className="inline-flex rounded-md border bg-muted/40 p-0.5">
          {DENSITIES.map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setDensity(value)}
              aria-pressed={density === value}
              className={cn(
                'rounded px-3 py-1.5 text-sm transition-colors',
                density === value
                  ? 'bg-background font-medium shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t(`appearance.${value}`)}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
