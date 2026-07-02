/**
 * token_coverage — o enforcement do "tokens-first": nenhum literal de cor
 * cru em `pkg/src/**` (fora tokens.css). `hsl(var(--x))` é o padrão
 * aprovado; Tailwind arbitrário `bg-[#0af]` é flagrado; hex em href/rota
 * hash não. Métrica: tokenRefs / (tokenRefs + literais).
 */
import { join } from 'node:path';
import { stripComments } from '../source-parse.js';
import { scanFiles } from './scan-utils.js';
import type { StudioAuditIssue, StudioThresholds } from './types.js';

const SOURCE_EXTS = ['.tsx', '.ts', '.jsx', '.js', '.vue', '.css', '.scss'] as const;

const HEX_LINE = /#[0-9a-fA-F]{3,8}\b/;
const COLOR_FN = /\b(rgba?|hsla?|oklch|oklab)\(/;
const TW_ARBITRARY = /-\[(#|rgb|hsl|oklch)[^\]]*\]/;

function isExemptLine(line: string): boolean {
  // Rotas hash (`'#/x'`), âncoras (`'#'`) e atributos de link carregam '#'
  // sem serem cor — mas `'#ff0000'` NÃO é isento (hex entre aspas é cor).
  return (
    (/href\s*=|\bto\s*=/.test(line) || /['"`]#\//.test(line) || /['"`]#['"`]/.test(line)) &&
    !TW_ARBITRARY.test(line)
  );
}

/** `hsl(var(--x))` e afins: função de cor cujo conteúdo é um token. */
function colorFnIsTokenized(line: string): boolean {
  const m = COLOR_FN.exec(line);
  if (!m) return false;
  const after = line.slice(m.index + m[0].length, m.index + m[0].length + 30);
  return after.trimStart().startsWith('var(');
}

export function checkTokenCoverage(opts: {
  workspaceDir: string;
  thresholds: StudioThresholds;
}): { errors: StudioAuditIssue[]; warnings: StudioAuditIssue[]; metric: number } {
  const errors: StudioAuditIssue[] = [];
  const warnings: StudioAuditIssue[] = [];
  const pkgSrc = join(opts.workspaceDir, 'pkg', 'src');
  let literals = 0;
  let tokenRefs = 0;

  for (const file of scanFiles(pkgSrc, SOURCE_EXTS)) {
    if (file.rel === 'tokens.css' || file.rel.endsWith('.d.ts')) continue;
    const text = stripComments(file.text);
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      tokenRefs += (line.match(/var\(--/g) ?? []).length;

      if (TW_ARBITRARY.test(line)) {
        literals++;
        errors.push({
          check: 'token_coverage',
          code: 'token_coverage.arbitrary_tw',
          message: `Tailwind arbitrary color value — move it into tokens.css and use a token class/var.`,
          file: `pkg/src/${file.rel}`,
          line: i + 1,
        });
        continue;
      }
      if (HEX_LINE.test(line) && !isExemptLine(line)) {
        literals++;
        errors.push({
          check: 'token_coverage',
          code: 'token_coverage.hex_literal',
          message: `Raw hex color literal — move the value into tokens.css and reference var(--…).`,
          file: `pkg/src/${file.rel}`,
          line: i + 1,
        });
        continue;
      }
      if (COLOR_FN.test(line) && !colorFnIsTokenized(line)) {
        literals++;
        errors.push({
          check: 'token_coverage',
          code: 'token_coverage.color_fn',
          message: `Raw color function (rgb/hsl/oklch) — approved pattern is hsl(var(--token)) or a tokens.css value.`,
          file: `pkg/src/${file.rel}`,
          line: i + 1,
        });
      }
    }
  }

  const metric = tokenRefs + literals === 0 ? 1 : tokenRefs / (tokenRefs + literals);
  if (metric < opts.thresholds.minTokenCoverage && errors.length === 0) {
    warnings.push({
      check: 'token_coverage',
      code: 'token_coverage.below_threshold',
      message: `Token coverage ${(metric * 100).toFixed(0)}% is below ${opts.thresholds.minTokenCoverage * 100}%.`,
    });
  }
  return { errors, warnings, metric };
}
