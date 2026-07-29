/**
 * Read-only query tools for a Builder project linked to a published design
 * system. They answer "what components exist / how do I use this one /
 * what do the docs say" straight from the DB rows frozen at publish time —
 * the agent must never guess props or invent imports.
 *
 *   ds_components — inventory (names, kinds, props summary, token names)
 *   ds_component  — full contract of ONE component (props schema, example)
 *   ds_docs       — docs.md, whole or by `## ` section
 */
import type { CoderTool, JsonSchema, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import type { DesignSystemStore, DesignSystemVersion } from '@mcp/store/design-system-store.js';
import { getDesignSystemStore } from '@mcp/company/tools/design-system/store-binding.js';
import {
  manifestComponent,
  manifestTokenNames,
  resolveConsumerVersion,
  sortComponents,
  summarizeProps,
  type DsConsumerBinding,
} from '@mcp/company/tools/design-system/consumer-resolve.js';

const NO_PARAMS: JsonSchema = { type: 'object', properties: {} };
const HTML_CAP = 2_000;
const DOCS_WHOLE_CAP = 8_000;
const SECTION_CAP = 16_000;

/** Null-guard the store + resolve the pinned version, then run `fn`. */
async function withVersion(
  binding: DsConsumerBinding,
  fn: (
    store: DesignSystemStore,
    version: DesignSystemVersion,
    newerSemver: string | null,
  ) => ToolResult | Promise<ToolResult>,
): Promise<ToolResult> {
  const store = getDesignSystemStore();
  if (!store) return err('Design system tools: DesignSystemStore not wired.');
  const resolved = await resolveConsumerVersion(store, binding);
  if (!resolved.ok) return err(resolved.error);
  return await fn(store, resolved.version, resolved.newerSemver);
}

function dsComponents(binding: DsConsumerBinding): CoderTool {
  return {
    name: 'ds_components',
    description:
      `Inventory of the linked design system (${binding.packageName}@${binding.semver}): every component with its kind and a props summary, plus the design token names. Call this before building UI so you reuse existing components instead of re-creating them.`,
    parameters: NO_PARAMS,
    source: 'native',
    handler: async () =>
      withVersion(binding, async (store, version, newerSemver) => {
        const components = sortComponents(await store.listComponents(version.id));
        const lines = components.map((c) => {
          const props = summarizeProps(c.props_schema_json);
          return `- ${c.name} (${c.kind})${props ? ` — props: ${props}` : ''}`;
        });
        const tokens = manifestTokenNames(version.manifest_json);
        const out = [
          `${binding.packageName}@${binding.semver} — ${components.length} component(s):`,
          lines.length ? lines.join('\n') : '(none registered)',
        ];
        if (tokens.length) out.push(`Design tokens: ${tokens.join(', ')}`);
        if (newerSemver) {
          out.push(
            `Note: the project pins @${binding.semver}, but ${binding.packageName}@${newerSemver} is published. ` +
              'If components seem missing or outdated, ask the user to UPDATE the design-system link from the project top bar (palette icon).',
          );
        }
        out.push('Use ds_component({ name }) for the full props schema + usage example of one component.');
        return ok(out.join('\n\n'));
      }),
  };
}

function dsComponent(binding: DsConsumerBinding): CoderTool {
  return {
    name: 'ds_component',
    description:
      'Full contract of ONE component of the linked design system: props schema, usage example and rendered markup. NEVER guess props — call this before using a component for the first time.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Component name as listed by ds_components (e.g. "Button").' },
      },
      required: ['name'],
    },
    source: 'native',
    handler: async (args) => {
      const name = String((args as { name?: unknown }).name ?? '').trim();
      if (!name) return err('ds_component: `name` is required.');
      return withVersion(binding, async (store, version) => {
        const components = await store.listComponents(version.id);
        const found =
          components.find((c) => c.name === name) ??
          components.find((c) => c.name.toLowerCase() === name.toLowerCase());
        if (!found) {
          const available = components.map((c) => c.name).join(', ') || '(none)';
          return err(`ds_component: '${name}' not found. Available: ${available}`);
        }
        const extras = manifestComponent(version.manifest_json, found.name);
        const parts = [`# ${found.name} (${found.kind}) — ${binding.packageName}@${binding.semver}`];
        if (extras?.description) parts.push(extras.description);
        parts.push(`Import: import { ${found.name} } from '${binding.packageName}'`);
        if (found.props_schema_json) parts.push(`Props schema:\n${found.props_schema_json}`);
        if (found.example_code) parts.push(`Usage example:\n${found.example_code}`);
        if (extras?.css_classes?.length) parts.push(`CSS classes: ${extras.css_classes.join(' ')}`);
        if (extras?.html) {
          const html = extras.html.length > HTML_CAP ? `${extras.html.slice(0, HTML_CAP)}…` : extras.html;
          parts.push(`Rendered markup:\n${html}`);
        }
        return ok(parts.join('\n\n'));
      });
    },
  };
}

function splitDocSections(docs: string): Array<{ heading: string; body: string }> {
  const sections: Array<{ heading: string; body: string }> = [];
  const re = /^##\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  let prev: { heading: string; start: number } | null = null;
  while ((match = re.exec(docs)) !== null) {
    if (prev) sections.push({ heading: prev.heading, body: docs.slice(prev.start, match.index).trim() });
    prev = { heading: match[1].trim(), start: match.index };
  }
  if (prev) sections.push({ heading: prev.heading, body: docs.slice(prev.start).trim() });
  return sections;
}

function dsDocs(binding: DsConsumerBinding): CoderTool {
  return {
    name: 'ds_docs',
    description:
      'Read the documentation of the linked design system — theming, setup, conventions.\n' +
      'Source is the published docs.md. Without arguments returns the whole doc (or a section index when long); pass `heading` to fetch one `## ` section.',
    parameters: {
      type: 'object',
      properties: { heading: { type: 'string', description: 'Optional `## ` section heading to fetch.' } },
    },
    source: 'native',
    handler: async (args) =>
      withVersion(binding, (_store, version) => {
        const docs = version.docs_md?.trim();
        if (!docs) return ok(`${binding.packageName}@${binding.semver} shipped no docs.md.`);
        const heading = String((args as { heading?: unknown }).heading ?? '').trim().toLowerCase();
        const sections = splitDocSections(docs);
        if (heading) {
          const hit = sections.find((s) => s.heading.toLowerCase().includes(heading));
          if (!hit) {
            const headings = sections.map((s) => s.heading).join(' | ') || '(none)';
            return err(`ds_docs: no section matching the given heading. Headings: ${headings}`);
          }
          return ok(hit.body.length > SECTION_CAP ? `${hit.body.slice(0, SECTION_CAP)}…` : hit.body);
        }
        if (docs.length <= DOCS_WHOLE_CAP || sections.length === 0) {
          return ok(docs.length > SECTION_CAP ? `${docs.slice(0, SECTION_CAP)}…` : docs);
        }
        const index = sections.map((s) => `- ${s.heading}`).join('\n');
        return ok(`Docs are long (${docs.length} chars). Sections:\n${index}\n\nCall ds_docs({ heading }) for one section.`);
      }),
  };
}

/** Consumer set — registered on builder sessions whose project links a DS. */
export function buildDesignSystemConsumerTools(binding: DsConsumerBinding): CoderTool[] {
  return [dsComponents(binding), dsComponent(binding), dsDocs(binding)];
}
