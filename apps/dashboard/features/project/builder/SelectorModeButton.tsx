import React from 'react';
import type { EffectiveSelectorMode, PreviewFramework, SelectorMode } from './useSelectorMode.js';

const ORDER: SelectorMode[] = ['auto', 'react', 'universal'];
const LABEL: Record<SelectorMode, string> = { auto: 'Auto', react: 'React', universal: 'Universal' };

/**
 * Compact 3-state selector-mode toggle shown beside the universal Inspect
 * button (imported Next/React projects only get the CDP picker). Clicking
 * cycles Auto → React → Universal. 'auto' resolves to the effective mode shown
 * in the label; the pill is tinted when React-native detection is active.
 */
export function SelectorModeButton({
  mode,
  effective,
  framework,
  onChange,
}: {
  mode: SelectorMode;
  effective: EffectiveSelectorMode;
  framework: PreviewFramework;
  onChange: (next: SelectorMode) => void;
}) {
  const isReact = effective === 'react';
  const label = mode === 'auto' ? `Auto · ${isReact ? 'React' : 'Universal'}` : LABEL[mode];
  return (
    <button
      type="button"
      onClick={() => onChange(ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length])}
      className={`px-1.5 py-1 rounded-md text-[11px] font-medium leading-none ${
        isReact
          ? 'bg-indigo-100 text-indigo-600 dark:bg-indigo-900/40'
          : 'hover:bg-muted text-muted-foreground'
      }`}
      title={
        `Element selector: ${LABEL[mode]}` +
        (mode === 'auto' ? ` (detected ${framework ?? 'none'} → ${effective})` : '') +
        `. Click to cycle Auto → React → Universal.` +
        (isReact ? ' Native React detection on.' : '')
      }
    >
      {label}
    </button>
  );
}
