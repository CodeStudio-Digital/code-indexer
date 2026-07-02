/**
 * gallery_coverage — comparação de três conjuntos: componentes REGISTRADOS
 * (store), EXPORTADOS (pkg/src/index.ts) e com DEMO na galeria. Registrado
 * sem demo/export = erro; exportado sem registro = warning na etapa e ERRO
 * no publish (mata o registro post-hoc da sessão 978); demo de código morto
 * = warning. Retorna também os blocos de demo p/ o variant-coverage.
 */
import { join } from 'node:path';
import { extractDemoEntries, extractExportedNames } from '../source-parse.js';
import { readIfExists } from './scan-utils.js';
import type { StudioAuditIssue } from './types.js';

const REGISTRY_BY_STACK: Record<string, string[]> = {
  'react-ts': ['app/src/gallery/registry.tsx', 'app/src/gallery/registry.ts'],
  'vue-ts': ['app/src/demos.ts', 'app/src/gallery/registry.ts'],
  angular: [],
};

const normalize = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');

export function checkGalleryCoverage(opts: {
  workspaceDir: string;
  stack: 'react-ts' | 'vue-ts' | 'angular';
  recorded: Array<{ name: string }>;
  scope: 'stage' | 'publish';
}): {
  errors: StudioAuditIssue[];
  warnings: StudioAuditIssue[];
  metric: number;
  demoEntries: Map<string, string>;
} {
  const errors: StudioAuditIssue[] = [];
  const warnings: StudioAuditIssue[] = [];
  const demoEntries = new Map<string, string>();

  const registryCandidates = REGISTRY_BY_STACK[opts.stack] ?? [];
  let registrySource: string | null = null;
  let registryPath: string | null = null;
  for (const rel of registryCandidates) {
    registrySource = readIfExists(join(opts.workspaceDir, rel));
    if (registrySource) {
      registryPath = rel;
      break;
    }
  }
  if (!registrySource) {
    warnings.push({
      check: 'gallery_coverage',
      code: 'gallery.registry_not_found',
      message:
        opts.stack === 'angular'
          ? 'Angular workspace has no demos registry the audit can parse — gallery coverage skipped.'
          : `Gallery registry not found (looked for: ${registryCandidates.join(', ')}).`,
    });
    return { errors, warnings, metric: 0, demoEntries };
  }

  for (const [key, block] of extractDemoEntries(registrySource)) demoEntries.set(key, block);
  const demoNames = new Set([...demoEntries.keys()].map(normalize));
  // Mapa `demos` presente mas vazio = sinal real de "nenhum demo"; ausente
  // (registry fora do padrão) = coverage indetectável, não acusar.
  const demosDetectable = demoNames.size > 0 || /\bdemos\b[^=]*=\s*\{/.test(registrySource);

  const indexSource = readIfExists(join(opts.workspaceDir, 'pkg', 'src', 'index.ts')) ?? '';
  const { names: exportNames, hasWildcard } = extractExportedNames(indexSource);
  if (hasWildcard) {
    warnings.push({
      check: 'gallery_coverage',
      code: 'gallery.wildcard_export',
      message: 'pkg/src/index.ts uses `export * from` — coverage per component is undetectable; use named exports.',
      file: 'pkg/src/index.ts',
    });
  }
  const exported = new Set(exportNames.map(normalize));
  const recorded = new Set(opts.recorded.map((c) => normalize(c.name)));

  for (const comp of opts.recorded) {
    const norm = normalize(comp.name);
    if (demosDetectable && !demoNames.has(norm)) {
      errors.push({
        check: 'gallery_coverage',
        code: 'gallery.demo_missing',
        message: `'${comp.name}' is recorded but has no gallery demo — add it to the registry so the user can see it.`,
        file: registryPath ?? undefined,
      });
    }
    if (exported.size > 0 && !exported.has(norm)) {
      errors.push({
        check: 'gallery_coverage',
        code: 'gallery.export_missing',
        message: `'${comp.name}' is recorded but not exported from pkg/src/index.ts — consumers cannot import it.`,
        file: 'pkg/src/index.ts',
      });
    }
  }

  for (const name of exportNames) {
    if (!recorded.has(normalize(name))) {
      const issue: StudioAuditIssue = {
        check: 'gallery_coverage',
        code: 'gallery.unrecorded_export',
        message: `'${name}' is exported but was never ds_record_component'ed — register it (or remove the export).`,
        file: 'pkg/src/index.ts',
      };
      if (opts.scope === 'publish') errors.push(issue);
      else warnings.push(issue);
    }
  }

  for (const key of demoEntries.keys()) {
    if (exported.size > 0 && !exported.has(normalize(key))) {
      warnings.push({
        check: 'gallery_coverage',
        code: 'gallery.demo_of_unexported',
        message: `Gallery demo '${key}' has no matching export in pkg/src/index.ts (dead demo?).`,
        file: registryPath ?? undefined,
      });
    }
  }

  const universe = Math.max(recorded.size, exported.size, 1);
  const matched = [...recorded].filter((n) => demoNames.has(n)).length;
  return { errors, warnings, metric: matched / universe, demoEntries };
}
