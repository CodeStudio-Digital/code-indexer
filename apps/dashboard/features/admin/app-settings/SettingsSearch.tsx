import { Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Input } from '../../../components/ui/input.js';
import { Switch } from '../../../components/ui/switch.js';

/** Search box (accent-insensitive) + advanced toggle + essential/advanced counts. */
export function SettingsSearch({
  query,
  onQuery,
  showAdvanced,
  onShowAdvanced,
  essentialsCount,
  advancedCount,
}: {
  query: string;
  onQuery: (v: string) => void;
  showAdvanced: boolean;
  onShowAdvanced: (v: boolean) => void;
  essentialsCount: number;
  advancedCount: number;
}) {
  const { t } = useTranslation('settings');
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <div className="relative flex-1 min-w-[200px]">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder={t('chrome.searchPlaceholder')}
          className="h-8 text-xs pl-8"
        />
      </div>
      <label className="flex items-center gap-2 cursor-pointer text-sm">
        <Switch checked={showAdvanced} onCheckedChange={onShowAdvanced} />
        <span>{t('chrome.showAdvanced')}</span>
      </label>
      <span className="text-muted-foreground text-xs">
        {t('chrome.counts', { essential: essentialsCount, advanced: advancedCount })}
      </span>
    </div>
  );
}
