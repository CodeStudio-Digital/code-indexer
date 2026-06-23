/**
 * Tool: `ds_list_components`. Lista os componentes registrados no draft
 * atual e na última versão publicada, para o agente do DS Studio manter
 * galeria ↔ registro sincronizados (saber o que já foi registrado, o que
 * é novo desde o último publish, e o que ainda falta registrar).
 */
import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import type { DsToolBinding } from '@mcp/company/tools/design-system/binding.js';
import type { DesignSystemComponent } from '@mcp/store/design-system-store.js';
import { getDesignSystemStore } from '@mcp/company/tools/design-system/store-binding.js';

const PARAMETERS: JsonSchema = {
  type: 'object',
  properties: {},
};

function formatList(label: string, components: DesignSystemComponent[]): string {
  if (components.length === 0) return `${label}: (none)`;
  const lines = components.map((c) => `  - ${c.name} (${c.kind})`);
  return `${label} — ${components.length} component(s):\n${lines.join('\n')}`;
}

export function dsListComponents(binding: DsToolBinding): CoderTool {
  return {
    name: 'ds_list_components',
    description:
      'List the components registered in the current draft and in the last published version of this Design System. Use it to know what is already registered before recording or publishing.',
    parameters: PARAMETERS,
    source: 'native',
    handler: async () => {
      try {
        const store = getDesignSystemStore();
        if (!store) return err('ds_list_components: DesignSystemStore not wired.');
        const session = binding.resolveDsSession(store);
        if (!session) {
          return err(`No DesignSystemSession bound to ${binding.describeBinding()}.`);
        }

        const draft = store.getLatestVersionAny(session.id);
        const published = store.getLatestPublishedVersion(session.id);
        const draftIsOpen = !!draft && (draft.status === 'draft' || draft.status === 'building');
        const draftComponents = draftIsOpen ? store.listComponents(draft.id) : [];
        const publishedComponents = published ? store.listComponents(published.id) : [];

        const publishedNames = new Set(publishedComponents.map((c) => c.name));
        const newSincePublish = draftComponents.filter((c) => !publishedNames.has(c.name));

        const lines = [
          formatList(
            draftIsOpen ? `Draft v${draft.semver} (${draft.status})` : 'Draft (none open)',
            draftComponents,
          ),
          formatList(
            published ? `Published v${published.semver}` : 'Published (never)',
            publishedComponents,
          ),
        ];
        if (draftIsOpen && newSincePublish.length > 0) {
          lines.push(
            `New since last publish: ${newSincePublish.map((c) => c.name).join(', ')}`,
          );
        }
        return ok(lines.join('\n\n'));
      } catch (e) {
        return err(`ds_list_components failed: ${(e as Error).message}`);
      }
    },
  };
}
