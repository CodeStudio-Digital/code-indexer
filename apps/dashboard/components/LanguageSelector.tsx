/**
 * Language picker for the app header. Sets the core locale (persisted via the
 * i18n store), which also flows to plugin webviews through the bridge. Native
 * <select> on purpose: zero dependency, fully accessible, and the option list
 * stays correct as locales are added to LOCALES.
 */
import { Languages } from 'lucide-react';
import { useLocaleStore } from '../state/i18n.js';
import { LOCALES, type Locale } from '../state/i18n-messages.js';

export function LanguageSelector() {
  const locale = useLocaleStore((s) => s.locale);
  const setLocale = useLocaleStore((s) => s.setLocale);

  return (
    <label className="flex items-center gap-1 text-muted-foreground" title="Language / Idioma">
      <Languages className="h-4 w-4" />
      <select
        value={locale}
        onChange={(e) => setLocale(e.target.value as Locale)}
        aria-label="Language"
        className="bg-transparent text-xs outline-none hover:text-foreground cursor-pointer py-1 pr-1"
      >
        {LOCALES.map((l) => (
          <option key={l.id} value={l.id} className="bg-popover text-popover-foreground">
            {l.nativeLabel}
          </option>
        ))}
      </select>
    </label>
  );
}
