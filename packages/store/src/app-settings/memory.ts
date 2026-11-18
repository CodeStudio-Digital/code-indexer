import type { SettingDef } from './types.js';

/**
 * Memory & consolidation — the periodic "tidy project memory" pass that merges
 * near-duplicate snapshots and reversibly archives stale/cold/low-importance
 * ones. The main toggle is user-facing; thresholds are advanced. Defaults mirror
 * DEFAULT_CONSOLIDATOR_OPTIONS + the host scheduler (sse/memory-consolidator.ts).
 * Hot-applied per pass — no restart needed.
 */
export const MEMORY_SETTINGS: readonly SettingDef[] = [
  {
    key: 'MCP_MEMORY_EVOLVE',
    label: 'Evolução automática das memórias',
    description: 'Revisa novos aprendizados na base dos agentes, consolida duplicatas e refina conteúdo com histórico reversível. Usa o destilador configurado, em lotes limitados e com intervalo por projeto. Memórias manuais, preferências e fixadas são protegidas.',
    type: 'bool', category: 'memory', default: '1',
  },
  {
    key: 'MCP_MEMORY_CONSOLIDATE',
    label: 'Legacy snapshot consolidator',
    description:
      'Legacy snapshots only; agent memories use Automatic memory evolution instead. Periodically merges near-duplicate memory snapshots and archives fully-stale, cold, ' +
      'low-importance ones. Archiving is reversible (restore from the project Memory tab). Runs only ' +
      'on idle projects whose memory changed since the last pass. Off by default (opt-in): set to 1 to arm.',
    type: 'bool',
    category: 'memory',
    default: '0',
    advanced: true,
  },
  {
    key: 'MCP_MEMORY_CONSOLIDATE_INTERVAL_MS',
    label: 'Consolidation interval (ms)',
    description: 'How often the consolidator wakes to scan idle projects. Default 21600000 (6h).',
    type: 'int',
    category: 'memory',
    default: '21600000',
    min: 600_000,
    advanced: true,
  },
  {
    key: 'MCP_MEMORY_CONSOLIDATE_IDLE_MS',
    label: 'Project idle gate (ms)',
    description: 'A project must have had no activity for at least this long to be eligible for a pass. Default 1800000 (30 min).',
    type: 'int',
    category: 'memory',
    default: '1800000',
    min: 60_000,
    advanced: true,
  },
  {
    key: 'MCP_MEMORY_CONSOLIDATE_MAX_PROJECTS',
    label: 'Max projects per pass',
    description: 'Upper bound on how many idle projects one consolidation pass processes. Default 3.',
    type: 'int',
    category: 'memory',
    default: '3',
    min: 1,
    advanced: true,
  },
  {
    key: 'MCP_MEMORY_MERGE_COSINE',
    label: 'Merge cosine threshold',
    description: 'Embedding cosine similarity at/above which two snapshots are treated as the same fact and merged. Default 0.92.',
    type: 'float',
    category: 'memory',
    default: '0.92',
    min: 0,
    max: 1,
    advanced: true,
  },
  {
    key: 'MCP_MEMORY_MERGE_TITLE_JACCARD',
    label: 'Merge title Jaccard (no-embeddings fallback)',
    description: 'Title token Jaccard threshold used to detect duplicates when no embedding backend is available. Default 0.6.',
    type: 'float',
    category: 'memory',
    default: '0.6',
    min: 0,
    max: 1,
    advanced: true,
  },
  {
    key: 'MCP_MEMORY_MAX_MERGES_PER_PASS',
    label: 'Max merges per project per pass',
    description: 'Caps how many duplicate clusters get merged per project in a single pass. Default 50.',
    type: 'int',
    category: 'memory',
    default: '50',
    min: 1,
    advanced: true,
  },
  {
    key: 'MCP_MEMORY_MAX_SNAPSHOTS_PER_PASS',
    label: 'Max snapshots scanned per pass',
    description: 'Bounds the work per project; projects with more snapshots are handled across multiple passes. Default 500.',
    type: 'int',
    category: 'memory',
    default: '500',
    min: 50,
    advanced: true,
  },
  {
    key: 'MCP_MEMORY_ARCHIVE_IMPORTANCE_MAX',
    label: 'Archive: max importance',
    description: 'Garbage-collect only snapshots below this importance (0–1). Default 0.35.',
    type: 'float',
    category: 'memory',
    default: '0.35',
    min: 0,
    max: 1,
    advanced: true,
  },
  {
    key: 'MCP_MEMORY_ARCHIVE_UNUSED_DAYS',
    label: 'Archive: unused for (days)',
    description: 'Only archive snapshots untouched for at least this many days. Default 90.',
    type: 'int',
    category: 'memory',
    default: '90',
    min: 1,
    advanced: true,
  },
  {
    key: 'MCP_MEMORY_ARCHIVE_MAX_ACCESS',
    label: 'Archive: max access count',
    description: 'Only archive snapshots accessed at most this many times. Default 1.',
    type: 'int',
    category: 'memory',
    default: '1',
    min: 0,
    advanced: true,
  },
];
