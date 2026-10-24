import { err, unknownToolOutcome, type ToolResult } from '../../core/tool.js';

export class BrowserOutcomeUnknownError extends Error {
  constructor(cause: unknown) {
    super(`Browser action completion is unconfirmed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'BrowserOutcomeUnknownError';
  }
}
export function browserFailure(error: unknown): ToolResult {
  return error instanceof BrowserOutcomeUnknownError ? unknownToolOutcome(error.message)
    : err(error instanceof Error ? error.message : String(error));
}
