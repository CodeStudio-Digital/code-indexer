/**
 * Presentation metadata for the layperson capability buckets — the facet a
 * pipeline (pipeline, role) belongs to. The classification itself is
 * server-side (`PipelineCatalogEntry.capabilityKind`, derived from the role);
 * this module only carries labels/icons/order so the filter bar and the
 * setup wizard render consistently.
 */
import { Brain, Search, ListFilter, Eye, Mic, Code2, Boxes } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { CapabilityKind, PipelineCatalogEntry } from '../pipeline-bindings-api.js';

/** A capability bucket, plus "outros" for custom bindings outside the catalog. */
export type CapabilityBucket = CapabilityKind | 'outros';

export interface CapabilityMeta {
  key: CapabilityBucket;
  /** Key suffix under `admin:pipelines.capability.*`. */
  i18nKey: string;
  icon: LucideIcon;
}

/** Display order of the capability buckets in the filter bar + wizard. */
export const CAPABILITY_BUCKETS: CapabilityMeta[] = [
  { key: 'text_llm',     i18nKey: 'textLlm',      icon: Brain },
  { key: 'embeddings',   i18nKey: 'embeddings',   icon: Search },
  { key: 'reranking',    i18nKey: 'reranking',    icon: ListFilter },
  { key: 'vision',       i18nKey: 'vision',       icon: Eye },
  { key: 'voice',        i18nKey: 'voice',        icon: Mic },
  { key: 'autocomplete', i18nKey: 'autocomplete', icon: Code2 },
  { key: 'outros',       i18nKey: 'outros',       icon: Boxes },
];

/** The bucket a catalog entry belongs to — "outros" when unclassified. */
export function bucketOf(catalog: PipelineCatalogEntry): CapabilityBucket {
  return catalog.capabilityKind ?? 'outros';
}

/** Presentation metadata for a single bucket. */
export function metaFor(key: CapabilityBucket): CapabilityMeta | undefined {
  return CAPABILITY_BUCKETS.find((b) => b.key === key);
}
