/**
 * System-prompt block for a Builder project linked to a published design
 * system (`builder_json.designSystem`). Mirrors the DS Studio block in
 * index.ts: appended after the agent prompt so the `builder` identity stays
 * intact. Everything here derives from the PINNED published version (rows
 * immutable after publish), so the block is byte-stable across turns —
 * prompt-cache safe. One bundle read per runCoder, no per-turn queries.
 */
// Leaf imports on purpose — the design-system barrel (index.js) drags the
// company orchestrator graph in and closes an import cycle back to
// code-agent. store-binding/consumer-resolve only depend on @mcp/store.
import { getDesignSystemStore } from '@mcp/company/tools/design-system/store-binding.js';
import {
  manifestTokenNames,
  sortComponents,
  summarizeProps,
} from '@mcp/company/tools/design-system/consumer-resolve.js';
import { interpolate, loadPrompt } from '../prompts/loader.js';
import type { DsConsumerConfig } from './builder-config.js';

const COMPONENT_CAP = 60;
const TOKEN_CAP = 40;

/** `store` is injectable for tests; defaults to the wired module global. */
export async function buildDsConsumerBlock(
  consumer: DsConsumerConfig,
  store: ReturnType<typeof getDesignSystemStore> = getDesignSystemStore(),
): Promise<string> {
  let componentSummary =
    '(inventory unavailable — the linked DS session/version was not found in the local registry metadata. ' +
    'The installed package still works; call ds_components to retry, or ask the user to re-link/unlink ' +
    'the design system from the project top bar.)';
  let tokensSummary = '(unavailable)';

  const version = store
    ? await (async () => {
        const session = await store.getSession(consumer.sessionId);
        if (!session) return null;
        const v = await store.getVersionBySemver(consumer.sessionId, consumer.semver);
        return v && v.status === 'published' ? v : null;
      })()
    : null;

  if (store && version) {
    const components = sortComponents(await store.listComponents(version.id));
    const shown = components.slice(0, COMPONENT_CAP);
    const lines = shown.map((c) => {
      const props = summarizeProps(c.props_schema_json, 100);
      return `- ${c.name} (${c.kind})${props ? ` — ${props}` : ''}`;
    });
    if (components.length > shown.length) {
      lines.push(`… and ${components.length - shown.length} more (ds_components lists all).`);
    }
    componentSummary = lines.length ? lines.join('\n') : '(no components registered in this version yet)';

    const tokens = manifestTokenNames(version.manifest_json, TOKEN_CAP);
    tokensSummary = tokens.length ? tokens.join(', ') : '(none declared in the manifest)';
  }

  return interpolate(loadPrompt('ds-consumer'), {
    packageName: consumer.packageName,
    semver: consumer.semver,
    componentSummary,
    tokensSummary,
  });
}
