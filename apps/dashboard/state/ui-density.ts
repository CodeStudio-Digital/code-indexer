/**
 * Densidade da IDE (tamanho de fonte + métricas) — Compacto/Confortável/Grande.
 * Afeta a UI base (via `[data-density]` no <html> + CSS vars do index.css), o
 * Explorer (altura de linha + fonte) e o editor Monaco (fontSize).
 *
 * As métricas de LAYOUT (altura de linha, fonte do editor) são expostas como
 * NÚMEROS porque o virtualizer e o Monaco precisam delas em JS; as cores/fontes
 * puramente visuais saem das CSS vars. Persiste em localStorage e é aplicada no
 * import (antes do primeiro paint) para não piscar a densidade padrão.
 */
import { create } from 'zustand';

export type Density = 'compact' | 'comfortable' | 'large';

export interface DensityMetrics {
  /** fontSize do Monaco (px). */
  editorFontPx: number;
  /** altura de cada linha do Explorer (px) — virtualizer estimateSize. */
  treeRowPx: number;
  /** fonte das linhas do Explorer (px). */
  treeFontPx: number;
}

const METRICS: Record<Density, DensityMetrics> = {
  compact: { editorFontPx: 13, treeRowPx: 22, treeFontPx: 11.5 },
  comfortable: { editorFontPx: 14, treeRowPx: 24, treeFontPx: 12.5 },
  large: { editorFontPx: 16, treeRowPx: 28, treeFontPx: 13.5 },
};

const STORAGE_KEY = 'mcp-ide:ui-density';
const DEFAULT: Density = 'comfortable';

function loadPersisted(): Density {
  if (typeof window === 'undefined') return DEFAULT;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === 'compact' || raw === 'comfortable' || raw === 'large' ? raw : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

/** Reflete a densidade no <html> (as CSS vars override por seletor de atributo). */
export function applyDensity(d: Density): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.density = d;
}

interface DensityState {
  density: Density;
  metrics: DensityMetrics;
  setDensity: (d: Density) => void;
}

const initial = loadPersisted();
applyDensity(initial); // side-effect no import → atributo setado antes do 1º render

export const useUiDensity = create<DensityState>((set) => ({
  density: initial,
  metrics: METRICS[initial],
  setDensity: (d) =>
    set(() => {
      try {
        window.localStorage.setItem(STORAGE_KEY, d);
      } catch {
        /* quota/disabled — non-fatal */
      }
      applyDensity(d);
      return { density: d, metrics: METRICS[d] };
    }),
}));

export const DENSITY_OPTIONS: ReadonlyArray<{ value: Density; label: string }> = [
  { value: 'compact', label: 'Compact' },
  { value: 'comfortable', label: 'Comfortable' },
  { value: 'large', label: 'Large' },
];
