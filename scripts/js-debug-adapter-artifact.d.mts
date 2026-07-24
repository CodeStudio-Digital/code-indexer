export const JS_DEBUG_VERSION: string;
export const JS_DEBUG_SHA256: string;
export const JS_DEBUG_URL: string;
export const WORKER_HANDOFF_ORIGINAL: string;
export const WORKER_PAUSE_HANDLER_ORIGINAL: string;

export function patchJsDebugWorkerHandoff(source: string): string;
export function extractJsDebugTarGz(archive: Uint8Array, targetRoot: string): void;
export function stageJsDebugAdapter(repoRoot: string, destination: string): Promise<string>;
