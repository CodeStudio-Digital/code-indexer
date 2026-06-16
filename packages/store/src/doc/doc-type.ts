/**
 * Documentation type taxonomy — tags each source (and, denormalized, each
 * chunk) with the KIND of documentation it holds, so ingestion, retrieval
 * formatting, and the agent's handling can branch per type instead of
 * assuming everything is an API reference. Single source of truth for the
 * vocabulary; reexported via `doc-store.ts`.
 *
 * `mixed` is the safe default: ingestion MAY classify a `mixed` source's
 * pages per-page (see the relevance gate), so nothing is forced into one
 * bucket. The UI select-box and the result formatter both read these values.
 */

export const DOC_TYPES = [
  'api_reference',
  'guide',
  'conceptual',
  'reference',
  'changelog',
  'handbook',
  'mixed',
] as const;

export type DocType = (typeof DOC_TYPES)[number];

/** Default when the operator doesn't pick a type — never limits to API refs. */
export const DEFAULT_DOC_TYPE: DocType = 'mixed';

/**
 * Short, English-canonical labels (the UI maps these to i18n keys; agent-facing
 * surfaces show the raw `DocType` value, which is already self-describing).
 */
export const DOC_TYPE_LABELS: Record<DocType, string> = {
  api_reference: 'API reference',
  guide: 'Guide / tutorial',
  conceptual: 'Conceptual',
  reference: 'Reference / spec',
  changelog: 'Changelog',
  handbook: 'Handbook',
  mixed: 'Mixed / auto-detect',
};

/** Coerce arbitrary input (DB row, HTTP body) to a valid DocType. */
export function coerceDocType(raw: unknown): DocType {
  return typeof raw === 'string' && (DOC_TYPES as readonly string[]).includes(raw)
    ? (raw as DocType)
    : DEFAULT_DOC_TYPE;
}
