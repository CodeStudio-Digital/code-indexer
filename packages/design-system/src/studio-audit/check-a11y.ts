/**
 * a11y — heurísticas de acessibilidade sobre pkg/src/components (regex,
 * não eslint: o scaffold não instala lint e regex é portável entre stacks):
 * div/span clicável sem semântica, img sem alt, dialog sem ARIA, inputs
 * sem label, button sem type e ausência de focus-visible no pacote.
 */
import { join } from 'node:path';
import { stripComments } from '../source-parse.js';
import { scanFiles } from './scan-utils.js';
import type { StudioAuditIssue } from './types.js';

const COMPONENT_EXTS = ['.tsx', '.jsx', '.vue'] as const;

export function checkA11y(opts: { workspaceDir: string }): {
  errors: StudioAuditIssue[];
  warnings: StudioAuditIssue[];
  metric: number;
} {
  const errors: StudioAuditIssue[] = [];
  const warnings: StudioAuditIssue[] = [];
  const componentsDir = join(opts.workspaceDir, 'pkg', 'src', 'components');
  const files = scanFiles(componentsDir, COMPONENT_EXTS);
  let interactive = false;
  let focusVisible = false;

  for (const file of files) {
    const text = stripComments(file.text);
    const rel = `pkg/src/components/${file.rel}`;
    if (/onClick|@click|<button|<a\b|<input|<select|<textarea/.test(text)) interactive = true;
    if (/focus-visible/.test(text)) focusVisible = true;

    for (const m of text.matchAll(/<(div|span)\b[^>]*onClick/g)) {
      const tag = text.slice(m.index, text.indexOf('>', m.index) + 1);
      if (!/role\s*=/.test(tag) || !/tabIndex/i.test(tag)) {
        errors.push({
          check: 'a11y',
          code: 'a11y.clickable_div',
          message: `Clickable <${m[1]}> without role + tabIndex — use <button> or add role/tabIndex/keyboard handling.`,
          file: rel,
        });
      }
    }
    for (const m of text.matchAll(/<img\b[^>]*>/g)) {
      if (!/\balt\s*=/.test(m[0])) {
        errors.push({
          check: 'a11y',
          code: 'a11y.img_no_alt',
          message: 'Image without alt attribute.',
          file: rel,
        });
      }
    }
    if (/modal|dialog|drawer|sheet/i.test(file.rel)) {
      const hasRole = /role\s*=\s*["'](alert)?dialog["']/.test(text);
      const hasModal = /aria-modal/.test(text);
      if (!hasRole && !hasModal) {
        errors.push({
          check: 'a11y',
          code: 'a11y.dialog_semantics',
          message: 'Dialog-like component without role="dialog"/aria-modal.',
          file: rel,
        });
      } else if (!hasRole || !hasModal) {
        warnings.push({
          check: 'a11y',
          code: 'a11y.dialog_semantics_partial',
          message: 'Dialog-like component has only partial ARIA (role="dialog" + aria-modal expected).',
          file: rel,
        });
      }
    }
    if (/input|select|checkbox|radio|switch|textarea/i.test(file.rel)) {
      const labeled = /aria-label|aria-labelledby|htmlFor|\{\.\.\.(props|rest)\}|v-bind\s*=\s*["']\$attrs["']/.test(text);
      if (!labeled) {
        warnings.push({
          check: 'a11y',
          code: 'a11y.unlabeled_input',
          message: 'Form component without label wiring (aria-label/aria-labelledby/htmlFor or props spread).',
          file: rel,
        });
      }
    }
    for (const m of text.matchAll(/<button\b[^>]*>/g)) {
      if (!/\btype\s*=/.test(m[0])) {
        warnings.push({
          check: 'a11y',
          code: 'a11y.button_no_type',
          message: '<button> without explicit type (defaults to submit inside forms).',
          file: rel,
        });
        break; // um aviso por arquivo basta
      }
    }
  }

  if (interactive && !focusVisible) {
    // tokens.css/estilos globais também contam como cobertura de foco.
    const styles = scanFiles(join(opts.workspaceDir, 'pkg', 'src'), ['.css', '.scss']);
    if (!styles.some((s) => /focus-visible/.test(s.text))) {
      warnings.push({
        check: 'a11y',
        code: 'a11y.no_focus_visible',
        message: 'Interactive components exist but no :focus-visible styling anywhere in pkg/src.',
      });
    }
  }
  return { errors, warnings, metric: errors.length === 0 ? 1 : 0 };
}
