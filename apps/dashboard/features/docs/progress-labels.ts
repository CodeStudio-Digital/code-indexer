/**
 * Shared phase → human label map for the doc indexer's progress UI.
 *
 * Extracted from `IndexProgressStream.tsx` so the live `SourceLiveProgress`
 * row in the table can render the same label without duplicating the
 * dictionary.
 */
import type { DocIngestPhase } from './docs-api.js';

export const PHASE_LABEL: Record<DocIngestPhase, string> = {
  fetching: 'Buscando páginas',
  gating: 'Filtrando relevância',
  chunking: 'Dividindo em chunks',
  enriching: 'Enriquecendo (LLM)',
  embedding: 'Calculando embeddings',
  done: 'Concluído',
  error: 'Erro',
};
