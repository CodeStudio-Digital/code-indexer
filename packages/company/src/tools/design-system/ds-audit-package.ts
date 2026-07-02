/**
 * Tool: `ds_audit_package`.
 *
 * Runs deterministic pre-publish checks over the generated package. It catches
 * missing MCP/Storybook artifacts and Storybook prop drift before
 * `ds_publish_version` can publish a broken tarball.
 *
 * Studio addition: components that exist on disk but were never
 * `ds_record_component`'ed are an ERROR — registration-as-you-go is the
 * contract (session 978 shipped 84 components with zero records; the
 * consumer-side inventory was empty until a post-hoc pass).
 */
import { readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import type { DsToolBinding } from '@mcp/company/tools/design-system/binding.js';
import { auditDesignSystemPackage, formatPackageAudit } from '@mcp/design-system/package-audit.js';
import { formatStudioAudit, runStudioAudit } from '@mcp/design-system/studio-audit/index.js';
import { resolveHostPath } from '@mcp/company/tools/design-system/ds-publish-version.js';
import { getDesignSystemStore } from '@mcp/company/tools/design-system/store-binding.js';
import { collectRecordedComponents } from '@mcp/company/tools/design-system/recorded-components.js';

const PARAMETERS: JsonSchema = {
  type: 'object',
  properties: {
    pkg_dir: {
      type: 'string',
      description: 'Path to the generated package directory. Defaults to pkg.',
    },
  },
};

const COMPONENT_EXTENSIONS = new Set(['.tsx', '.jsx', '.ts', '.vue']);
const NON_COMPONENT_NAMES = new Set(['index', 'types', 'utils', 'helpers', 'constants', 'styles']);

const normalize = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Top-level component names under `<pkg>/src/components` (dirs or source files). */
function listFsComponents(pkgDir: string): string[] {
  let entries;
  try {
    entries = readdirSync(join(pkgDir, 'src', 'components'), { withFileTypes: true });
  } catch {
    return []; // layout without src/components (e.g. angular lib) — check not applicable
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      names.push(entry.name);
      continue;
    }
    const ext = extname(entry.name).toLowerCase();
    if (!COMPONENT_EXTENSIONS.has(ext) || entry.name.endsWith('.d.ts')) continue;
    const base = entry.name.slice(0, -ext.length);
    if (!NON_COMPONENT_NAMES.has(base.toLowerCase())) names.push(base);
  }
  return names;
}

/** Disk components missing from the registered (draft ∪ last published) set. */
function findUnregistered(binding: DsToolBinding, pkgDir: string): string[] | null {
  const store = getDesignSystemStore();
  if (!store) return null;
  const session = binding.resolveDsSession(store);
  if (!session) return null;

  const registered = new Set<string>();
  const draft = store.getLatestVersionAny(session.id);
  if (draft && (draft.status === 'draft' || draft.status === 'building')) {
    for (const c of store.listComponents(draft.id)) registered.add(normalize(c.name));
  }
  const published = store.getLatestPublishedVersion(session.id);
  if (published) {
    for (const c of store.listComponents(published.id)) registered.add(normalize(c.name));
  }
  return listFsComponents(pkgDir).filter((name) => !registered.has(normalize(name)));
}

export function dsAuditPackage(binding: DsToolBinding): CoderTool {
  return {
    name: 'ds_audit_package',
    description:
      'Audit the generated Design System package before publish: package.json files/exports/peerDependencies, docs, stack artefacts, and (studio) that every component on disk is registered. Run it before ds_publish_version and fix every error it reports.',
    parameters: PARAMETERS,
    source: 'native',
    handler: async (args, ctx) => {
      const pkgArg = typeof args.pkg_dir === 'string' && args.pkg_dir.trim()
        ? args.pkg_dir.trim()
        : 'pkg';
      const resolved = resolveHostPath(pkgArg, ctx);
      if (resolved.kind === 'no-bind-mount') return err(resolved.message);

      const result = await auditDesignSystemPackage(resolved.path, { profile: binding.profile });
      let formatted = formatPackageAudit(result);
      let failed = !result.ok;

      if (binding.profile === 'studio') {
        const unregistered = findUnregistered(binding, resolved.path);
        if (unregistered && unregistered.length > 0) {
          failed = true;
          formatted += [
            '',
            `ERROR components.unregistered — ${unregistered.length} component(s) on disk were never registered:`,
            ...unregistered.map((n) => `  - ${n}`),
            'Register each approved component with ds_record_component({ name, kind, props_schema_json, example_code }) before publishing.',
          ].join('\n');
        }

        // Auditoria de DESIGN (tokens-first, fidelidade, galeria, variantes,
        // docs, a11y) — o package-audit acima só cobre o shape do pacote.
        const store = getDesignSystemStore();
        const session = store ? binding.resolveDsSession(store) : null;
        if (store && session) {
          const workspace = resolveHostPath('.', ctx);
          if (workspace.kind !== 'no-bind-mount') {
            const studio = await runStudioAudit({
              workspaceDir: workspace.path,
              stack: session.stack,
              mode: session.mode,
              recorded: collectRecordedComponents(store, session.id),
              scope: 'stage',
            });
            if (!studio.ok) failed = true;
            formatted += `\n\n${formatStudioAudit(studio)}`;
          }
        }
      }

      if (failed) return err(formatted);
      return ok(formatted);
    },
  };
}
