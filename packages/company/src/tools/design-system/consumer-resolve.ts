/**
 * Shared resolution + formatting helpers for the DS CONSUMER tools — a
 * Builder project linked to a published design system (the inverse of the
 * studio tools, which author one). The binding is the pin persisted in
 * `projects.builder_json.designSystem`; published version rows are
 * immutable, so everything derived here is stable for the session.
 */
import type {
  DesignSystemComponent,
  DesignSystemSession,
  DesignSystemStore,
  DesignSystemVersion,
} from '@mcp/store/design-system-store.js';

export interface DsConsumerBinding {
  sessionId: number;
  packageName: string;
  semver: string;
}

export type ConsumerResolution =
  | {
      ok: true;
      session: DesignSystemSession;
      version: DesignSystemVersion;
      /** Latest published semver when it differs from the pin (link is behind). */
      newerSemver: string | null;
    }
  | { ok: false; error: string };

/** Resolve the pinned session+version, with a clear stale-link message. */
export function resolveConsumerVersion(
  store: DesignSystemStore,
  binding: DsConsumerBinding,
): ConsumerResolution {
  const stale = (what: string): ConsumerResolution => ({
    ok: false,
    error:
      `Linked design system ${binding.packageName}@${binding.semver}: ${what}. ` +
      'The installed package in node_modules keeps working, but its metadata is gone — ' +
      'ask the user to re-link (or unlink) the design system from the project top bar.',
  });
  const session = store.getSession(binding.sessionId);
  if (!session) return stale('the DS session no longer exists');
  const version = store.getVersionBySemver(binding.sessionId, binding.semver);
  if (!version || version.status !== 'published') {
    return stale(`version ${binding.semver} is no longer published`);
  }
  const latest = store.getLatestPublishedVersion(binding.sessionId);
  const newerSemver = latest && latest.semver !== binding.semver ? latest.semver : null;
  return { ok: true, session, version, newerSemver };
}

/** One-line props summary out of a JSON-schema-ish props_schema_json. */
export function summarizeProps(propsSchemaJson: string | null, maxLen = 160): string {
  if (!propsSchemaJson) return '';
  try {
    const schema = JSON.parse(propsSchemaJson) as { properties?: Record<string, unknown> };
    const props = schema?.properties;
    if (!props || typeof props !== 'object') return '';
    const parts = Object.entries(props).map(([name, def]) => {
      const d = def as { enum?: unknown[]; type?: unknown };
      if (Array.isArray(d?.enum) && d.enum.length > 0) {
        return `${name}: ${d.enum.slice(0, 6).map(String).join('|')}`;
      }
      return typeof d?.type === 'string' ? `${name}: ${d.type}` : name;
    });
    const joined = parts.join(', ');
    return joined.length > maxLen ? `${joined.slice(0, maxLen - 1)}…` : joined;
  } catch {
    return '';
  }
}

/** Flattened token names (depth ≤ 2, dot-joined) from manifest_json.tokens. */
export function manifestTokenNames(manifestJson: string | null, cap = 40): string[] {
  if (!manifestJson) return [];
  try {
    const manifest = JSON.parse(manifestJson) as { tokens?: Record<string, unknown> };
    const tokens = manifest?.tokens;
    if (!tokens || typeof tokens !== 'object') return [];
    const names: string[] = [];
    for (const [key, value] of Object.entries(tokens)) {
      if (names.length >= cap) break;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const sub of Object.keys(value as Record<string, unknown>)) {
          if (names.length >= cap) break;
          names.push(`${key}.${sub}`);
        }
      } else {
        names.push(key);
      }
    }
    return names;
  } catch {
    return [];
  }
}

export interface ManifestComponentExtras {
  description?: string;
  category?: string;
  css_classes?: string[];
  html?: string;
}

/** Manifest-side extras for one component (the DB row carries the rest). */
export function manifestComponent(
  manifestJson: string | null,
  name: string,
): ManifestComponentExtras | null {
  if (!manifestJson) return null;
  try {
    const manifest = JSON.parse(manifestJson) as { components?: Array<Record<string, unknown>> };
    const found = manifest?.components?.find(
      (c) => typeof c?.name === 'string' && c.name.toLowerCase() === name.toLowerCase(),
    );
    if (!found) return null;
    return {
      description: typeof found.description === 'string' ? found.description : undefined,
      category: typeof found.category === 'string' ? found.category : undefined,
      css_classes: Array.isArray(found.css_classes) ? found.css_classes.map(String) : undefined,
      html: typeof found.html === 'string' ? found.html : undefined,
    };
  } catch {
    return null;
  }
}

/** Stable inventory ordering: atoms first, then page templates, A→Z. */
export function sortComponents(components: DesignSystemComponent[]): DesignSystemComponent[] {
  return [...components].sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name),
  );
}
