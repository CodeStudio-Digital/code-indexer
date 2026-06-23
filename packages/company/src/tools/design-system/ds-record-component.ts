/**
 * Tool: `ds_record_component`. Subordinate components-builder /
 * pages-builder calls this each time it produces a component or page
 * template, so the dashboard can list it under the active draft
 * version.
 *
 * The tool resolves the active draft version of the DS session bound
 * to the current company session. If no draft exists yet, it creates
 * one (`semver=pending`, `bump_kind=initial`). The semver is rewritten
 * by `ds_publish_version` once the master finalises the build.
 */
import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import type { DsToolBinding } from '@mcp/company/tools/design-system/binding.js';
import type {
  DesignSystemStore,
  DesignSystemSession,
  DesignSystemVersion,
} from '@mcp/store/design-system-store.js';
import { getDesignSystemStore } from '@mcp/company/tools/design-system/store-binding.js';

const PARAMETERS: JsonSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Component name (PascalCase).' },
    kind: {
      type: 'string',
      enum: ['atom', 'page-template'],
      description: 'Atomic component (Button, Card) or full page template (DashboardPage).',
    },
    props_schema_json: {
      type: 'string',
      description: 'JSON schema describing the component props.',
    },
    example_code: {
      type: 'string',
      description: 'Minimal example snippet (JSX/Vue/Angular template).',
    },
  },
  required: ['name', 'kind'],
};

export function dsRecordComponent(binding: DsToolBinding): CoderTool {
  return {
    name: 'ds_record_component',
    description:
      'Persist a Design System component or page template into the active draft version. Call this for every component you generate so the dashboard can list it.',
    parameters: PARAMETERS,
    source: 'native',
    handler: async (args) => {
      try {
        const store = getDesignSystemStore();
        if (!store) {
          return err('ds_record_component: DesignSystemStore not wired.');
        }
        const name = mustString(args.name, 'name');
        const kind = mustEnum(args.kind, ['atom', 'page-template'], 'kind') as
          | 'atom'
          | 'page-template';
        const props_schema_json = optString(args.props_schema_json) ?? null;
        const example_code = optString(args.example_code) ?? null;

        const session = binding.resolveDsSession(store);
        if (!session) {
          return err(
            `No DesignSystemSession bound to ${binding.describeBinding()}. Was this session created via the Design Systems tab?`,
          );
        }

        const draft = ensureDraftVersion(store, session);
        const existing = store.getComponentByName(draft.id, name);
        if (existing) {
          return ok(
            `Component '${name}' already recorded in draft v${draft.semver} (id=${existing.id}). Skipping insert.`,
          );
        }

        const component = store.createComponent({
          version_id: draft.id,
          name,
          kind,
          props_schema_json,
          example_code,
        });
        return ok(
          `Recorded ${kind} '${name}' (id=${component.id}) under draft v${draft.semver} of "${session.package_name}".`,
        );
      } catch (e) {
        return err(`ds_record_component failed: ${(e as Error).message}`);
      }
    },
  };
}

/**
 * Return the current draft version, creating one when none exists.
 * Pure-ish: reads the latest version row of any status; if it's already
 * in `published` or `failed`, opens a new draft. `bump_kind` defaults to
 * the session's `next_bump_hint` (or 'initial' for the first version).
 */
export function ensureDraftVersion(
  store: DesignSystemStore,
  session: DesignSystemSession,
): DesignSystemVersion {
  const latest = store.getLatestVersionAny(session.id);
  if (latest && (latest.status === 'draft' || latest.status === 'building')) {
    return latest;
  }
  const isFirst = !latest || !store.getLatestPublishedVersion(session.id);
  return store.createVersion({
    ds_session_id: session.id,
    semver: 'pending',
    bump_kind: isFirst ? 'initial' : session.next_bump_hint,
    status: 'draft',
  });
}

function mustString(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`${field} must be a non-empty string`);
  }
  return v;
}

function mustEnum<T extends string>(v: unknown, allowed: readonly T[], field: string): T {
  if (typeof v !== 'string' || !allowed.includes(v as T)) {
    throw new Error(`${field} must be one of ${allowed.join(', ')}`);
  }
  return v as T;
}

function optString(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  if (v.trim() === '') return undefined;
  return v;
}
