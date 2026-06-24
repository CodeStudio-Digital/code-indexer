/**
 * Appearance pane — IDE interface density (compact / comfortable / large).
 * Re-homed here from the Admin "Aparência" tab. The density is a global UI
 * preference (drives the base chrome, the file explorer and the Monaco editor
 * via state/ui-density.ts, persisted in localStorage), so this pane talks to
 * that store directly and takes no project/patch props — it lives in the
 * project settings modal only because that is where users look for it.
 */
import { useTranslation } from 'react-i18next';
import { cn } from '../../../../lib/utils.js';
import { useUiDensity, type Density } from '../../../../state/ui-density.js';

const DENSITIES: readonly Density[] = ['compact', 'comfortable', 'large'];

export function AppearancePane() {
  const { t } = useTranslation(['projects']);
  const density = useUiDensity((s) => s.density);
  const setDensity = useUiDensity((s) => s.setDensity);

  return (
    <div className="space-y-5 max-w-xl">
      <div className="space-y-0.5">
        <h3 className="text-sm font-semibold">{t('settings.nav.appearance')}</h3>
        <p className="text-xs text-muted-foreground">{t('settings.appearance.subtitle')}</p>
      </div>

      <section className="space-y-2">
        <label className="text-sm font-medium">{t('settings.appearance.density')}</label>
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
              {t(`settings.appearance.${value}`)}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
