/**
 * runStudioAudit — orquestra os checks de qualidade de design do DS Studio.
 * Irmão do package-audit (shape do pacote): aqui é fidelidade ao tema,
 * tokens-first, cobertura de galeria/variantes/docs e a11y. Consumido pelo
 * ds_audit_package (profile studio) e pelo gate de publish.
 */
import { DEFAULT_THRESHOLDS, type StudioAuditInput, type StudioAuditResult, type StudioCheckId } from './types.js';
import { checkTokenCoverage } from './check-token-coverage.js';
import { checkThemeFidelity } from './check-theme-fidelity.js';
import { checkGalleryCoverage } from './check-gallery-coverage.js';
import { checkDocsDepth, checkVariantCoverage } from './check-content-quality.js';
import { checkA11y } from './check-a11y.js';

export type { StudioAuditInput, StudioAuditIssue, StudioAuditResult, StudioCheckId } from './types.js';
export { DEFAULT_THRESHOLDS } from './types.js';

const ALL_CHECKS: StudioCheckId[] = [
  'token_coverage', 'theme_fidelity', 'gallery_coverage', 'variant_coverage', 'docs_depth', 'a11y',
];

export async function runStudioAudit(input: StudioAuditInput): Promise<StudioAuditResult> {
  const checks = new Set(input.checks ?? ALL_CHECKS);
  const thresholds = { ...DEFAULT_THRESHOLDS, ...input.thresholds };
  const result: StudioAuditResult = { ok: true, errors: [], warnings: [], metrics: {} };
  const absorb = (
    check: StudioCheckId,
    r: { errors: StudioAuditResult['errors']; warnings: StudioAuditResult['warnings']; metric?: number | null },
  ) => {
    result.errors.push(...r.errors);
    result.warnings.push(...r.warnings);
    if (typeof r.metric === 'number') result.metrics[check] = r.metric;
  };

  if (checks.has('token_coverage')) {
    absorb('token_coverage', checkTokenCoverage({ workspaceDir: input.workspaceDir, thresholds }));
  }
  if (checks.has('theme_fidelity')) {
    absorb('theme_fidelity', await checkThemeFidelity({
      workspaceDir: input.workspaceDir,
      mode: input.mode,
      thresholds,
    }));
  }

  let demoEntries = new Map<string, string>();
  if (checks.has('gallery_coverage') || checks.has('variant_coverage')) {
    const gallery = checkGalleryCoverage({
      workspaceDir: input.workspaceDir,
      stack: input.stack,
      recorded: input.recorded,
      scope: input.scope,
    });
    demoEntries = gallery.demoEntries;
    if (checks.has('gallery_coverage')) absorb('gallery_coverage', gallery);
  }
  if (checks.has('variant_coverage')) {
    absorb('variant_coverage', checkVariantCoverage({ recorded: input.recorded, demoEntries }));
  }
  if (checks.has('docs_depth')) {
    absorb('docs_depth', checkDocsDepth({
      workspaceDir: input.workspaceDir,
      recorded: input.recorded,
      scope: input.scope,
      thresholds,
    }));
  }
  if (checks.has('a11y')) {
    absorb('a11y', checkA11y({ workspaceDir: input.workspaceDir }));
  }

  result.ok = result.errors.length === 0;
  return result;
}

export function formatStudioAudit(result: StudioAuditResult): string {
  const lines: string[] = [];
  lines.push(result.ok ? 'Studio audit: OK' : `Studio audit: ${result.errors.length} error(s)`);
  for (const issue of result.errors) {
    lines.push(`ERROR ${issue.code}${issue.file ? ` (${issue.file}${issue.line ? `:${issue.line}` : ''})` : ''}: ${issue.message}`);
  }
  for (const issue of result.warnings) {
    lines.push(`warn ${issue.code}${issue.file ? ` (${issue.file}${issue.line ? `:${issue.line}` : ''})` : ''}: ${issue.message}`);
  }
  const metrics = Object.entries(result.metrics);
  if (metrics.length > 0) {
    lines.push(
      'metrics: ' + metrics.map(([k, v]) => `${k}=${(v * 100).toFixed(0)}%`).join(' · '),
    );
  }
  return lines.join('\n');
}
