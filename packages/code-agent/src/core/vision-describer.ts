/**
 * Vision describer bridge — the process-singleton the vision-fallback transform
 * calls, mirroring `setGlobalPreviewDevtools` (tools/preview/bridge.ts) and
 * `setGlobalDocSearch` (rag-search-docs.ts).
 *
 * The REAL implementation lives MAIN-SIDE in the http-api process: it resolves
 * the `code-agent/vision` Pipelines role to a (provider, model), runs a one-off
 * chat with the image + an agent-directed prompt, and returns the text. In the
 * coder/company WORKER, a shim is installed that forwards `describe` over the
 * worker→host MessageBridge (`visionDescribe`). In headless / unconfigured runs
 * nothing is wired → the transform degrades (keeps the image / emits a note).
 */

/** A single image-to-text request. */
export interface VisionDescribeRequest {
  /** Raw base64 (no data: prefix). */
  base64: string;
  /** e.g. 'image/png' | 'image/jpeg' | 'image/webp'. */
  mediaType: string;
  /** Agent-directed instruction: what to look for / how to describe. */
  prompt: string;
}

export interface IVisionDescriber {
  describe(req: VisionDescribeRequest): Promise<string>;
}

/** Thrown (by message) when no vision model is bound for the role. */
export const VISION_NOT_CONFIGURED = 'VISION_NOT_CONFIGURED';

let globalVision: IVisionDescriber | null = null;

/** Wire the singleton. http-api main sets the real describer; the worker sets a
 *  bridge shim; headless leaves it null. Pass null to detach (tests). */
export function setGlobalVisionDescriber(impl: IVisionDescriber | null): void {
  globalVision = impl;
}

export function getGlobalVisionDescriber(): IVisionDescriber | null {
  return globalVision;
}
