/**
 * StyleSettingsCard — the inspector editor for the project's StudioSettings:
 * art-style keywords, palette mode + fixed colors, canvas size preset,
 * perspective, outline and negative keywords. Edits are local echoes committed
 * on change via the passed `onSaveSettings` (the orchestrator wires it to
 * useSpriteStudio.saveSettings).
 *
 * Props (mounted by InspectorPanel / the orchestrator):
 *   settings:       StudioSettings          — current project settings
 *   onSaveSettings: (next) => void|Promise  — persist the mutated settings
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Palette } from 'lucide-react';
import { Input } from '../../../components/ui/input.js';
import {
  CANVAS_PRESETS,
  type OutlineStyle, type PaletteMode, type Perspective, type StudioSettings,
} from '../types.js';
import { InspectorSection } from './InspectorSection.js';

const PALETTE_MODES: PaletteMode[] = ['free', 'maxColors', 'fixed'];
const PERSPECTIVES: Perspective[] = ['side', 'top-down', 'three-quarter', 'isometric'];
const OUTLINES: OutlineStyle[] = ['none', 'black', 'colored', 'selective'];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

const selectCls = 'h-7 rounded border bg-background px-2 text-xs';

export function StyleSettingsCard({
  settings,
  onSaveSettings,
}: {
  settings: StudioSettings;
  onSaveSettings: (next: StudioSettings) => void | Promise<void>;
}) {
  const { t } = useTranslation('spriteStudio');
  const [keywords, setKeywords] = useState(settings.styleKeywords.join(', '));
  const [negative, setNegative] = useState(settings.negativeKeywords.join(', '));
  const [colors, setColors] = useState(settings.palette.colors.join(', '));

  useEffect(() => {
    setKeywords(settings.styleKeywords.join(', '));
    setNegative(settings.negativeKeywords.join(', '));
    setColors(settings.palette.colors.join(', '));
  }, [settings]);

  const commit = (next: StudioSettings) => void onSaveSettings(next);
  const parseList = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean);

  const onCanvas = (v: string) => {
    const n = Number(v);
    commit({ ...settings, canvas: { ...settings.canvas, width: n, height: n } });
  };

  return (
    <InspectorSection id="style" icon={Palette} title={t('styleSettings.title')}>
      <Field label={t('styleSettings.styleKeywords')}>
        <Input
          value={keywords}
          onChange={(e) => setKeywords(e.target.value)}
          onBlur={() => commit({ ...settings, styleKeywords: parseList(keywords) })}
          placeholder={t('styleSettings.keywordsPlaceholder')}
          className="h-7 text-xs"
        />
      </Field>

      <div className="grid grid-cols-2 gap-2">
        <Field label={t('styleSettings.canvas')}>
          <select
            className={selectCls}
            value={CANVAS_PRESETS.includes(settings.canvas.width) ? String(settings.canvas.width) : ''}
            onChange={(e) => onCanvas(e.target.value)}
          >
            {!CANVAS_PRESETS.includes(settings.canvas.width) && (
              <option value="">{`${settings.canvas.width}×${settings.canvas.height}`}</option>
            )}
            {CANVAS_PRESETS.map((p) => <option key={p} value={String(p)}>{`${p}×${p}`}</option>)}
          </select>
        </Field>
        <Field label={t('styleSettings.perspective.label')}>
          <select
            className={selectCls}
            value={settings.perspective}
            onChange={(e) => commit({ ...settings, perspective: e.target.value as Perspective })}
          >
            {PERSPECTIVES.map((p) => <option key={p} value={p}>{t(`styleSettings.perspective.${p}`)}</option>)}
          </select>
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field label={t('styleSettings.paletteMode.label')}>
          <select
            className={selectCls}
            value={settings.palette.mode}
            onChange={(e) => commit({ ...settings, palette: { ...settings.palette, mode: e.target.value as PaletteMode } })}
          >
            {PALETTE_MODES.map((m) => <option key={m} value={m}>{t(`styleSettings.paletteMode.${m}`)}</option>)}
          </select>
        </Field>
        <Field label={t('styleSettings.outline.label')}>
          <select
            className={selectCls}
            value={settings.outline.style}
            onChange={(e) => commit({ ...settings, outline: { ...settings.outline, style: e.target.value as OutlineStyle } })}
          >
            {OUTLINES.map((o) => <option key={o} value={o}>{t(`styleSettings.outline.${o}`)}</option>)}
          </select>
        </Field>
      </div>

      {settings.palette.mode === 'maxColors' && (
        <Field label={t('styleSettings.maxColors')}>
          <Input
            type="number"
            min={2}
            max={256}
            value={settings.palette.maxColors ?? 16}
            onChange={(e) => commit({ ...settings, palette: { ...settings.palette, maxColors: Number(e.target.value) } })}
            className="h-7 text-xs"
          />
        </Field>
      )}

      {settings.palette.mode === 'fixed' && (
        <Field label={t('styleSettings.colors')}>
          <Input
            value={colors}
            onChange={(e) => setColors(e.target.value)}
            onBlur={() => commit({ ...settings, palette: { ...settings.palette, colors: parseList(colors) } })}
            placeholder={t('styleSettings.colorsPlaceholder')}
            className="h-7 text-xs font-mono"
          />
        </Field>
      )}

      <Field label={t('styleSettings.negativeKeywords')}>
        <Input
          value={negative}
          onChange={(e) => setNegative(e.target.value)}
          onBlur={() => commit({ ...settings, negativeKeywords: parseList(negative) })}
          placeholder={t('styleSettings.negativePlaceholder')}
          className="h-7 text-xs"
        />
      </Field>
    </InspectorSection>
  );
}
