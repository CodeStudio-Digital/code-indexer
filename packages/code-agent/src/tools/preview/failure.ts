import { err, unknownToolOutcome, type ToolResult } from '@mcp/agent-runtime-host/tool-result.js';

/** The RPC was dispatched, but the host did not confirm its effect. */
export class PreviewOutcomeUnknownError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'PreviewOutcomeUnknownError';
  }
}

export function previewFailure(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return error instanceof PreviewOutcomeUnknownError
    ? unknownToolOutcome(`Preview effect is unconfirmed: ${message}. Inspect the page before retrying.`)
    : err(message);
}
