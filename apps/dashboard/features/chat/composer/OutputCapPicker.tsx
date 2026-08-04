/**
 * Compact tool-output cap selector for the Composer icon row.
 *
 * Replaces the old binary "unrestricted output" toggle: a `Maximize2` trigger
 * (amber when the level is elevated) opens a popover listing the 6 levels
 * (Econômico → Ultra) with their headline cap. Selecting one persists per
 * session via the parent's `onChange` (PATCH `/tool-output-cap-level`).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Maximize2 } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover.js';
import { OUTPUT_CAP_LEVELS, isElevatedCapLevel, type OutputCapLevel } from './output-cap-levels.js';

interface OutputCapPickerProps {
  value: OutputCapLevel;
  onChange: (v: OutputCapLevel) => void;
}

export function OutputCapPicker({ value, onChange }: OutputCapPickerProps) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  const elevated = isElevatedCapLevel(value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={t('toolbar.outputCap.hint', {
            defaultValue:
              'Limite de saída por tool-call. Escala o cap de truncação (Econômico ~24 KB → Ultra ~4 MB) para leituras grandes / Unity. Auto-compactação continua. Aplica na próxima mensagem.',
          })}
          aria-label={t('toolbar.outputCap.heading', { defaultValue: 'Saída de ferramentas' })}
          className={`relative inline-flex items-center justify-center h-7 w-7 rounded-md transition-colors ${
            elevated
              ? 'bg-amber-500/15 text-amber-500 hover:bg-amber-500/25'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted'
          }`}
        >
          <Maximize2 className="h-3.5 w-3.5" />
          {elevated && (
            <span aria-hidden className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-amber-500" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-1.5" align="start" side="top">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground px-2 py-1">
          {t('toolbar.outputCap.heading', { defaultValue: 'Saída de ferramentas' })}
        </div>
        {OUTPUT_CAP_LEVELS.map((o) => {
          const isActive = o.key === value;
          return (
            <button
              key={o.key}
              type="button"
              onClick={() => {
                onChange(o.key);
                setOpen(false);
              }}
              className={`w-full text-left px-2 py-1.5 rounded text-xs flex items-center justify-between gap-2 ${
                isActive ? 'bg-amber-500/15 text-amber-500' : 'hover:bg-muted'
              }`}
            >
              <span className="font-medium">{t(o.labelKey, { defaultValue: o.defaultLabel })}</span>
              <span className={`text-[11px] ${isActive ? 'text-amber-500/80' : 'text-muted-foreground'}`}>
                {o.hint}
              </span>
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
