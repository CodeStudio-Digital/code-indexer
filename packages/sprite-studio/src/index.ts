// Repo layout: .sprite-studio/ paths, slugs and JSON manifests.
export * from './repo/paths.js';
export * from './repo/slug.js';
export * from './repo/manifest.js';

// Jobs: event contract, DI seam, queue, runner, pricing, candidate promotion.
export * from './jobs/events.js';
export * from './jobs/deps.js';
export * from './jobs/prompt-template.js';
export * from './jobs/queue.js';
export * from './jobs/pricing.js';
export * from './jobs/generation-request.js';
export * from './jobs/job-runner.js';
export * from './jobs/pick-candidate.js';

// Animation (F2): action catalog, frame-pack prompt, all-candidate promotion.
export * from './jobs/action-catalog.js';
export * from './jobs/animation-prompt.js';
export * from './jobs/promote-frames.js';

// Export: grid composer + atlas adapters + pure orchestrator.
export * from './export/index.js';

// Processing: pure RGBA ops + PNG codec + pipeline dispatcher.
export * from './processing/types.js';
export * from './processing/color.js';
export * from './processing/png.js';
export * from './processing/decode-image.js';
export * from './processing/quantize.js';
export * from './processing/resize.js';
export * from './processing/background.js';
export * from './processing/fit.js';
export * from './processing/slice.js';
export * from './processing/outline.js';
export * from './processing/alpha-cleanup.js';
export * from './processing/auto-crop.js';
export * from './processing/ops.js';
