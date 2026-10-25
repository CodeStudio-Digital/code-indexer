import { useState } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../../components/ui/badge.js';
import { SettingInput } from './SettingInput.js';
import { SourceBadge } from './SourceBadge.js';
import type { SettingItem } from './types.js';

/** One setting: human label (primary) + copyable variable name + description + editor. */
export function SettingRow({
  item,
  edit,
  onChange,
  onClear,
}: {
  item: SettingItem;
  edit: string | null | undefined;
  onChange: (v: string | null) => void;
  onClear: () => void;
}) {
  const { t } = useTranslation('settings');
  const [copied, setCopied] = useState(false);
  const dirty = edit !== undefined;
  const displayValue = dirty ? edit ?? '' : item.value ?? '';
  const label = t(`item.${item.key}.label`, { defaultValue: item.label });
  const description = t(`item.${item.key}.description`, { defaultValue: item.description });

  const copyKey = (): void => {
    void navigator.clipboard?.writeText(item.key);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="px-3 py-2.5 flex items-start gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[13px] font-medium text-foreground">{label}</span>
          {item.restartNeeded && (
            <Badge
              variant="outline"
              className="border-amber-500/40 text-amber-600 dark:text-amber-400 text-[9.5px] px-1.5 py-0 h-4"
            >
              <AlertTriangle className="h-2.5 w-2.5 mr-1" />
              {t('chrome.restartBadge')}
            </Badge>
          )}
          {item.advanced && (
            <Badge variant="secondary" className="text-[9.5px] px-1.5 py-0 h-4">
              {t('chrome.advancedBadge')}
            </Badge>
          )}
          <SourceBadge source={item.source} />
        </div>
        <button
          type="button"
          onClick={copyKey}
          title={t('chrome.copyKey')}
          className="block font-mono text-[10.5px] text-muted-foreground/80 hover:text-foreground mt-0.5"
        >
          {copied ? t('chrome.copied') : item.key}
        </button>
        {description && (
          <div className="text-[11.5px] text-muted-foreground mt-0.5 leading-snug">{description}</div>
        )}
        {item.validationError && (
          <div role="alert" className="text-xs text-destructive mt-1">{t('error.invalidStored')}</div>
        )}
      </div>
      <div className="shrink-0 w-[240px] flex items-center gap-2">
        <SettingInput item={item} value={displayValue} dirty={dirty} onChange={onChange} />
        {dirty && (
          <button
            type="button"
            onClick={onClear}
            className="text-muted-foreground hover:text-foreground"
            title={t('chrome.discardEdit')}
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
