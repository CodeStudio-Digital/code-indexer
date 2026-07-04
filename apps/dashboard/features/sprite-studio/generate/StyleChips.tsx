/**
 * StyleChips — a compact, read-only summary of the project's StudioSettings
 * rendered as chips above the prompt (canvas size, palette mode, perspective,
 * outline, negative-keyword count). Editing lives in the inspector's
 * StyleSettingsCard; this is purely informational so the user sees the style
 * contract every generation inherits.
 */
import { useTranslation } from 'react-i18next';
import { Ruler, Palette, Axis3d, Square, Ban } from 'lucide-react';
import type { StudioSettings } from '../types.js';

function Chip({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <span
      title={`${label}: ${value}`}
      className="inline-flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-[10px] text-muted-foreground"
    >
      <Icon className="h-3 w-3 shrink-0 opacity-70" />
      <span className="font-medium text-foreground/80">{value}</span>
    </span>
  );
}

export function StyleChips({ settings }: { settings: StudioSettings | null }) {
  const { t } = useTranslation('spriteStudio');
  if (!settings) return null;

  const paletteValue =
    settings.palette.presetName ??
    (settings.palette.mode === 'maxColors' && settings.palette.maxColors != null
      ? t('generate.chips.maxColors', { n: settings.palette.maxColors })
      : t(`styleSettings.paletteMode.${settings.palette.mode}`));

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Chip
        icon={Ruler}
        label={t('generate.chips.canvas')}
        value={`${settings.canvas.width}×${settings.canvas.height}`}
      />
      <Chip icon={Palette} label={t('generate.chips.palette')} value={paletteValue} />
      <Chip
        icon={Axis3d}
        label={t('generate.chips.perspective')}
        value={t(`styleSettings.perspective.${settings.perspective}`)}
      />
      <Chip
        icon={Square}
        label={t('generate.chips.outline')}
        value={t(`styleSettings.outline.${settings.outline.style}`)}
      />
      {settings.negativeKeywords.length > 0 && (
        <Chip
          icon={Ban}
          label={t('generate.chips.negative')}
          value={String(settings.negativeKeywords.length)}
        />
      )}
    </div>
  );
}
