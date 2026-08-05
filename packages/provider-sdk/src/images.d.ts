/**
 * Image generation — the third client surface next to coder (streaming chat)
 * and indexer (single-shot). A provider opts in by setting
 * `capabilities.supportsImageGen` and the engine builds a per-wire
 * `ImageGenClient` via `createImages` on the definition.
 *
 * Model identity rides `provider_models.mode === 'image'` — image models are
 * discovered/tagged by the SAME live discovery as chat models (family regexes,
 * never hardcoded versions), so a newly released model shows up with zero code
 * changes. Manual model entry remains the escape hatch.
 */
/** An input image (reference, mask) as raw base64 (no data: prefix). */
export interface ImageRef {
    base64: string;
    /** e.g. 'image/png', 'image/jpeg', 'image/webp'. */
    mediaType: string;
}
export interface ImageGenRequest {
    /** Overrides the model the client was bound with. One of the two required. */
    model?: string;
    prompt: string;
    /** Number of candidates. Default 1. Backends without native n loop. */
    n?: number;
    /** Provider-native size string, e.g. '1024x1024' | '1536x1024' | 'auto'. */
    size?: string;
    /** Transparent output when the backend supports it (see capabilities). */
    background?: 'transparent' | 'opaque' | 'auto';
    quality?: 'low' | 'medium' | 'high' | 'auto';
    /** Honored only when `capabilities().seed` (diffusion backends). */
    seed?: number;
    /** Honored only when `capabilities().negativePrompt`. */
    negativePrompt?: string;
    /**
     * Non-empty ⇒ edit / img2img path (openai edits endpoint, gemini
     * inline_data conditioning). Length must respect `maxReferenceImages`.
     */
    referenceImages?: ImageRef[];
    /** Inpaint mask (white = editable) when `capabilities().mask`. */
    mask?: ImageRef;
    /** img2img strength 0..1 (diffusion backends only). */
    strength?: number;
    signal?: AbortSignal;
    /** Coarse progress for slow/pollable backends (comfyui). Best-effort. */
    onProgress?: (p: {
        pct?: number;
        note?: string;
    }) => void;
}
export interface GeneratedImage {
    base64: string;
    mediaType: string;
    /** Backend-rewritten prompt when reported (openai revised_prompt). */
    revisedPrompt?: string;
}
export interface ImageGenResult {
    images: GeneratedImage[];
    /**
     * Provider-reported usage when available (gpt-image usage block, gemini
     * usageMetadata). Null/absent ⇒ caller prices via its flat table.
     */
    usage?: {
        inputTokens?: number;
        outputTokens?: number;
    } | null;
}
/**
 * What this client can actually do — load-bearing for failover: the job
 * runner walks a binding chain and SKIPS links that can't satisfy the
 * request (e.g. edit-with-references on a txt2img-only model) instead of
 * failing mid-chain.
 */
export interface ImageGenCapabilities {
    /** Accepts `referenceImages` (edit / img2img). */
    edit: boolean;
    /** Accepts an inpaint `mask`. */
    mask: boolean;
    /** Honors `background: 'transparent'` natively. */
    transparentBackground: boolean;
    /** Deterministic `seed`. */
    seed: boolean;
    negativePrompt: boolean;
    /** 0 when `edit` is false. */
    maxReferenceImages: number;
}
export interface ImageGenClient {
    generate(req: ImageGenRequest): Promise<ImageGenResult>;
    capabilities(): ImageGenCapabilities;
}
//# sourceMappingURL=images.d.ts.map