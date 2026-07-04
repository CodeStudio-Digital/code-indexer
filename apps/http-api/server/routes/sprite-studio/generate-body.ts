/**
 * POST /generate body parsing — pure helpers split from generate.routes.ts so
 * the body→job-params mapping is unit-testable and the route stays under the
 * LOC ceiling. The body is backward compatible: plain generations keep
 * sending {prompt,n,assetId,rawPrompt,seed}; the edit flows (selection
 * inpaint / whole-image enhance) add kind + versionId (+ maskBase64).
 */
import type { ImageRef } from '@mcp/provider-sdk';
import type { SpriteGenerationJobParams } from '@mcp/sprite-studio/jobs/generation-request.js';
import type { SpriteStyleConfig } from '@mcp/store/sprite-studio/types.js';

/** Gemini caps at 3 conditioning images — the lowest common denominator. */
export const MAX_GENERATION_REFS = 3;

/** Wire body of the generate route (superset of the legacy generation body). */
export interface GenerateRouteBody {
  prompt?: string;
  n?: number;
  assetId?: number;
  rawPrompt?: boolean;
  seed?: number | null;
  /** 'inpaint' | 'enhance' route to the img2img flow; anything else → generate. */
  kind?: string;
  /** Version to edit — required for inpaint/enhance. */
  versionId?: number;
  /** Raw base64 PNG mask (no data: prefix), white = repaint. Masks are small. */
  maskBase64?: string;
  /** Reserved: img2img strength (0..1). Persisted in the snapshot only for now. */
  strength?: number;
  // ── reference conditioning (plain generation) ──
  /** Attach the asset's CURRENT version as the identity reference. */
  useCurrentAsRef?: boolean;
  /** Library versions to attach as references (must belong to this project). */
  referenceIds?: number[];
  /** Disk uploads (client downscales to ≤768px): raw base64, no data: prefix. */
  uploadRefs?: Array<{ base64: string; mediaType: string }>;
}

/**
 * Assemble the reference list for a PLAIN generation, in priority order:
 * current version (identity anchor) → library versions → disk uploads,
 * capped at MAX_GENERATION_REFS. `readVersionPng` is injected so this stays
 * a pure, unit-testable mapping.
 */
export function buildGenerationRefs(
  body: GenerateRouteBody,
  readVersionPng: (versionId: number) => Buffer | null,
  currentVersionId: number | null,
): ImageRef[] {
  const refs: ImageRef[] = [];
  const seen = new Set<number>();
  const pushVersion = (versionId: number) => {
    if (refs.length >= MAX_GENERATION_REFS || seen.has(versionId)) return;
    const png = readVersionPng(versionId);
    if (!png) return;
    seen.add(versionId);
    refs.push({ base64: png.toString('base64'), mediaType: 'image/png' });
  };
  if (body.useCurrentAsRef && currentVersionId != null) pushVersion(currentVersionId);
  for (const id of body.referenceIds ?? []) {
    if (typeof id === 'number') pushVersion(id);
  }
  for (const up of body.uploadRefs ?? []) {
    if (refs.length >= MAX_GENERATION_REFS) break;
    if (typeof up?.base64 === 'string' && up.base64.length > 0) {
      refs.push({ base64: up.base64, mediaType: up.mediaType || 'image/png' });
    }
  }
  return refs;
}

export type SpriteEditKind = 'inpaint' | 'enhance';

/** Which edit flow the body asks for; null → plain generation (legacy path). */
export function editKindOf(body: GenerateRouteBody): SpriteEditKind | null {
  return body.kind === 'inpaint' || body.kind === 'enhance' ? body.kind : null;
}

/** Clamp the requested variant count to [1..max] (generation 8, edits 4). */
export function clampVariantCount(n: number | undefined, max: number): number {
  return Math.max(1, Math.min(max, n ?? 1));
}

/** Request snapshot persisted on the job row (UI rehydration + provenance). */
export function editRequestSnapshot(
  kind: SpriteEditKind,
  body: GenerateRouteBody,
): Record<string, unknown> {
  return {
    n: clampVariantCount(body.n, 4),
    rawPrompt: !!body.rawPrompt,
    seed: body.seed ?? null,
    kind,
    versionId: body.versionId,
    hasMask: !!body.maskBase64,
    ...(typeof body.strength === 'number' ? { strength: body.strength } : {}),
  };
}

/**
 * Job params for an edit flow: the version PNG rides as the (single)
 * reference image — `linkSatisfies` then routes to edit-capable links only —
 * and the mask (when present) additionally requires mask-capable links.
 * `packVariants` is forced OFF: grid-packing an EDIT of one specific image
 * makes no sense (each candidate must be an independent img2img pass).
 */
export function buildEditJobParams(
  body: GenerateRouteBody,
  style: SpriteStyleConfig,
  versionPng: Buffer,
): SpriteGenerationJobParams {
  return {
    intent: body.prompt ?? '',
    style,
    n: clampVariantCount(body.n, 4),
    rawPrompt: body.rawPrompt,
    seed: body.seed ?? undefined,
    referenceImages: [{ base64: versionPng.toString('base64'), mediaType: 'image/png' }],
    ...(body.maskBase64 ? { mask: { base64: body.maskBase64, mediaType: 'image/png' } } : {}),
    packVariants: false,
  };
}
