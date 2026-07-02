/**
 * variant_coverage + docs_depth — profundidade por componente:
 * (a) props enum do `props_schema_json` precisam aparecer renderizadas no
 *     bloco de demo da galeria (um Button com 6 tones mostrando 1 = raso);
 * (b) todo componente registrado precisa de seção substancial em
 *     pkg/docs.md (com exemplo em code fence e props documentadas).
 */
import { join } from 'node:path';
import { readIfExists } from './scan-utils.js';
import type { StudioAuditIssue, StudioThresholds } from './types.js';

interface RecordedInput {
  name: string;
  props_schema_json?: string | null;
}

function enumProps(schemaJson: string | null | undefined): Record<string, string[]> {
  if (!schemaJson) return {};
  try {
    const schema = JSON.parse(schemaJson) as Record<string, unknown>;
    const properties = (schema.properties ?? schema) as Record<string, unknown>;
    const out: Record<string, string[]> = {};
    for (const [prop, def] of Object.entries(properties)) {
      if (!def || typeof def !== 'object') continue;
      const values = (def as { values?: unknown; enum?: unknown }).values
        ?? (def as { enum?: unknown }).enum;
      if (Array.isArray(values)) {
        const strings = values.filter((v): v is string => typeof v === 'string');
        if (strings.length >= 2) out[prop] = strings;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function valueRendered(demoBlock: string, value: string): boolean {
  return new RegExp(`["'\`{\\s]${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'\`}\\s,]`).test(demoBlock);
}

export function checkVariantCoverage(opts: {
  recorded: RecordedInput[];
  demoEntries: Map<string, string>;
}): { errors: StudioAuditIssue[]; warnings: StudioAuditIssue[]; metric: number | null } {
  const errors: StudioAuditIssue[] = [];
  const warnings: StudioAuditIssue[] = [];
  const coverages: number[] = [];
  const normalize = (n: string) => n.toLowerCase().replace(/[^a-z0-9]/g, '');
  const demosByNorm = new Map([...opts.demoEntries].map(([k, v]) => [normalize(k), v]));

  for (const comp of opts.recorded) {
    const enums = enumProps(comp.props_schema_json);
    const props = Object.entries(enums);
    if (props.length === 0) continue;
    const demo = demosByNorm.get(normalize(comp.name));
    if (!demo) continue; // gallery_coverage já cobra o demo ausente

    for (const [prop, values] of props) {
      const shown = values.filter((v) => valueRendered(demo, v));
      coverages.push(shown.length / values.length);
      if (shown.length < 2) {
        errors.push({
          check: 'variant_coverage',
          code: 'variants.insufficient',
          message: `'${comp.name}' demo renders ${shown.length} of ${values.length} '${prop}' values — show every variant (${values.join(', ')}).`,
        });
      } else if (shown.length < values.length) {
        warnings.push({
          check: 'variant_coverage',
          code: 'variants.partial',
          message: `'${comp.name}' demo misses '${prop}' values: ${values.filter((v) => !shown.includes(v)).join(', ')}.`,
        });
      }
    }
  }
  const metric = coverages.length > 0
    ? coverages.reduce((s, c) => s + c, 0) / coverages.length
    : null;
  return { errors, warnings, metric };
}

export function checkDocsDepth(opts: {
  workspaceDir: string;
  recorded: RecordedInput[];
  scope: 'stage' | 'publish';
  thresholds: StudioThresholds;
}): { errors: StudioAuditIssue[]; warnings: StudioAuditIssue[]; metric: number } {
  const errors: StudioAuditIssue[] = [];
  const warnings: StudioAuditIssue[] = [];
  const docs = readIfExists(join(opts.workspaceDir, 'pkg', 'docs.md'));
  if (!docs) {
    errors.push({
      check: 'docs_depth',
      code: 'docs.missing',
      message: 'pkg/docs.md not found.',
      file: 'pkg/docs.md',
    });
    return { errors, warnings, metric: 0 };
  }

  // Seções por heading (## ou ###), nome normalizado → corpo.
  const sections = new Map<string, string>();
  const parts = docs.split(/^#{2,3}\s+(.+)$/m);
  for (let i = 1; i < parts.length - 1; i += 2) {
    sections.set(parts[i].trim().toLowerCase().replace(/[^a-z0-9]/g, ''), parts[i + 1] ?? '');
  }

  let covered = 0;
  for (const comp of opts.recorded) {
    const norm = comp.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const body = sections.get(norm);
    if (body == null) {
      const issue: StudioAuditIssue = {
        check: 'docs_depth',
        code: 'docs.section_missing',
        message: `pkg/docs.md has no section for '${comp.name}'.`,
        file: 'pkg/docs.md',
      };
      if (opts.scope === 'publish') errors.push(issue);
      else warnings.push(issue);
      continue;
    }
    covered++;
    if (body.trim().length < opts.thresholds.minDocsSectionChars) {
      warnings.push({
        check: 'docs_depth',
        code: 'docs.thin',
        message: `'${comp.name}' docs section has ${body.trim().length} chars (min ${opts.thresholds.minDocsSectionChars}) — document props, variants and usage.`,
        file: 'pkg/docs.md',
      });
    }
    if (!/```/.test(body)) {
      warnings.push({
        check: 'docs_depth',
        code: 'docs.no_example',
        message: `'${comp.name}' docs section has no code example.`,
        file: 'pkg/docs.md',
      });
    }
  }
  return {
    errors,
    warnings,
    metric: opts.recorded.length > 0 ? covered / opts.recorded.length : 1,
  };
}
