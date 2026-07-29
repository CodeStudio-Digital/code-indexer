/**
 * Tool: `ds_analyze_import`. Regenera o theme digest determinístico sobre
 * `import/` (útil quando o usuário troca arquivos manualmente) e atualiza o
 * resumo no pipeline_json. O digest também roda no scaffold e na rota de
 * re-extract — esta tool é o caminho de dentro da sessão.
 */
import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import type { DsToolBinding } from '@mcp/company/tools/design-system/binding.js';
import { getDesignSystemStore } from '@mcp/company/tools/design-system/store-binding.js';
import { resolveHostPath } from '@mcp/company/tools/design-system/ds-publish-version.js';
import { writeThemeDigest } from '@mcp/design-system/theme-digest/theme-digest.js';
import { parsePipelineState, serializePipelineState } from '@mcp/design-system/pipeline/stages.js';

const PARAMETERS: JsonSchema = { type: 'object', properties: {} };

export function dsAnalyzeImport(binding: DsToolBinding): CoderTool {
  return {
    name: 'ds_analyze_import',
    description:
      'Re-run the deterministic theme analysis over import/ — regenerates import/_analysis/THEME.md and theme-digest.json. Use it after the reference material changes.',
    parameters: PARAMETERS,
    source: 'native',
    handler: async (_args, ctx) => {
      try {
        const resolved = resolveHostPath('import', ctx);
        if (resolved.kind === 'no-bind-mount') return err(resolved.message);

        const summary = await writeThemeDigest(resolved.path);

        const store = getDesignSystemStore();
        const session = store ? await binding.resolveDsSession(store) : null;
        const state = session ? parsePipelineState(session.pipeline_json) : null;
        if (store && session && state) {
          state.theme_digest = summary;
          await store.setPipelineJson(session.id, serializePipelineState(state));
        }
        return ok(
          `Theme digest regenerated: ${summary.files} files scanned, ${summary.colors} colors, ` +
            `${summary.components} component candidates. Read import/_analysis/THEME.md.`,
        );
      } catch (e) {
        return err(`ds_analyze_import failed: ${(e as Error).message}`);
      }
    },
  };
}
