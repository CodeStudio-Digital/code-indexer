/**
 * Shared phase → i18n-key map for the doc indexer's progress UI.
 *
 * Values are i18n keys (resolved by callers via `t()`), not literal
 * strings — keeps the progress phase strings in `docs.json` next to
 * the rest of the docs feature i18n. Extracted from
 * `IndexProgressStream.tsx` so the live `SourceLiveProgress` row in
 * the table can render the same label without duplicating the
 * dictionary.
 */
import type { DocIngestPhase } from './docs-api.js';

export const PHASE_LABEL: Record<DocIngestPhase, string> = {
  fetching: 'progress.phase.fetching',
  gating: 'progress.phase.gating',
  chunking: 'progress.phase.chunking',
  enriching: 'progress.phase.enriching',
  embedding: 'progress.phase.embedding',
  done: 'progress.phase.done',
  error: 'progress.phase.error',
};
