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
export {};
//# sourceMappingURL=images.js.map