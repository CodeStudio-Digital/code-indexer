/**
 * theme_fidelity — o referee objetivo do modo Fidelidade: cada token de COR
 * saturado em pkg/src/tokens.css precisa estar perto (distância RGB
 * ponderada) de alguma cor MEDIDA no scan determinístico de import/ (não do
 * digest escrito pelo agente — anti-circularidade). Fontes idem. Em modo
 * criativo o mesmo cálculo vira UM warning-resumo (aderência %), nunca
 * bloqueia. Sem import/ → check pulado.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { scanCssTokens } from '../theme-digest/css-token-scan.js';
import { colorDistance, extractColors, saturationOf } from '../theme-digest/color-normalize.js';
import { readIfExists } from './scan-utils.js';
import type { StudioAuditIssue, StudioThresholds } from './types.js';

const GENERIC_FONTS = new Set(['sans-serif', 'serif', 'monospace', 'system-ui', 'inherit']);

interface TokenColor {
  name: string;
  hex: string;
}

/** Tokens de cor de tokens.css: `--x: #hex` / rgb()/hsl() (rem/px ignorados). */
function parseTokenColors(tokensCss: string): TokenColor[] {
  const out: TokenColor[] = [];
  for (const m of tokensCss.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)) {
    const [hex] = extractColors(m[2]);
    if (hex) out.push({ name: m[1], hex });
  }
  return out;
}

export async function checkThemeFidelity(opts: {
  workspaceDir: string;
  mode: 'fidelity' | 'creative';
  thresholds: StudioThresholds;
}): Promise<{ errors: StudioAuditIssue[]; warnings: StudioAuditIssue[]; metric: number | null }> {
  const errors: StudioAuditIssue[] = [];
  const warnings: StudioAuditIssue[] = [];
  const importDir = join(opts.workspaceDir, 'import');
  if (!existsSync(importDir)) return { errors, warnings, metric: null };

  const tokensCss = readIfExists(join(opts.workspaceDir, 'pkg', 'src', 'tokens.css'));
  if (!tokensCss) return { errors, warnings, metric: null };

  const theme = await scanCssTokens(importDir);
  if (theme.colors.length === 0) return { errors, warnings, metric: null };

  const palette = theme.colors.map((c) => c.hex);
  const saturated = parseTokenColors(tokensCss).filter(
    (t) => saturationOf(t.hex) >= opts.thresholds.fidelityMinSaturation,
  );
  if (saturated.length === 0) return { errors, warnings, metric: null };

  const offPalette: Array<TokenColor & { nearest: string; distance: number }> = [];
  for (const token of saturated) {
    let nearest = palette[0];
    let best = Number.POSITIVE_INFINITY;
    for (const hex of palette) {
      const d = colorDistance(token.hex, hex);
      if (d < best) {
        best = d;
        nearest = hex;
      }
    }
    if (best > opts.thresholds.fidelityColorTolerance) {
      offPalette.push({ ...token, nearest, distance: Math.round(best) });
    }
  }

  const metric = 1 - offPalette.length / saturated.length;
  if (opts.mode === 'fidelity') {
    for (const t of offPalette) {
      errors.push({
        check: 'theme_fidelity',
        code: 'theme_fidelity.off_palette',
        message: `${t.name} is ${t.hex}; nearest theme color is ${t.nearest} (distance ${t.distance}) — use the measured theme value.`,
        file: 'pkg/src/tokens.css',
      });
    }
  } else if (offPalette.length > 0) {
    warnings.push({
      check: 'theme_fidelity',
      code: 'theme_fidelity.adherence',
      message: `Theme adherence ${(metric * 100).toFixed(0)}% — ${offPalette.length}/${saturated.length} saturated tokens are off the reference palette (ok in creative mode; keep the brand colors as protagonists).`,
      file: 'pkg/src/tokens.css',
    });
  }

  // Fontes: famílias declaradas fora do tema (fallbacks genéricos isentos).
  const themeFonts = new Set(theme.fonts.map((f) => f.value.toLowerCase()));
  if (themeFonts.size > 0) {
    for (const m of tokensCss.matchAll(/--font[\w-]*\s*:\s*([^;}]+)/g)) {
      const family = m[1].split(',')[0].trim().replace(/^['"]|['"]$/g, '').toLowerCase();
      if (!family || GENERIC_FONTS.has(family) || family.startsWith('ui-')) continue;
      if (!themeFonts.has(family)) {
        const issue: StudioAuditIssue = {
          check: 'theme_fidelity',
          code: 'theme_fidelity.off_font',
          message: `Font '${family}' does not appear in the theme (theme fonts: ${[...themeFonts].join(', ')}).`,
          file: 'pkg/src/tokens.css',
        };
        if (opts.mode === 'fidelity') errors.push(issue);
        else warnings.push(issue);
      }
    }
  }
  return { errors, warnings, metric };
}
