/**
 * Module-level holder for the global tool-selection filter.
 *
 * The application's boot path calls `setGlobalToolSelectionFilter(fn)`
 * with the wired-up filter from `deps.buildToolSelectionFilter()`. After
 * that, every `runCoder()` call benefits from the filter without having
 * to pass it through each call-site (there are ~7 call-sites scattered
 * across http-api, cli, and company orchestration).
 *
 * Same pattern the codebase already uses for cross-cutting concerns like
 * `setCompanySandboxStore`, `setEnvToolStore`.
 *
 * When `runCoder()` receives an explicit `opts.toolSelectionFilter`, that
 * wins — the global is only the FALLBACK.
 */
import type { RunnerOptions } from '../core/runner.js';
import type { SessionId } from '@mcp/session-storage';

type Filter = NonNullable<RunnerOptions['toolSelectionFilter']>;

let globalFilter: Filter | undefined;

/**
 * Install the global tool-selection filter. Called once during app boot.
 * Passing `undefined` clears any prior installation (useful for tests).
 */
export function setGlobalToolSelectionFilter(fn: Filter | undefined): void {
  globalFilter = fn;
}

/**
 * Retrieve the currently-installed global filter, or undefined if none
 * was installed. Consumed by `runCoder` as a fallback when the caller
 * doesn't pass an explicit `toolSelectionFilter`.
 */
export function getGlobalToolSelectionFilter(): Filter | undefined {
  return globalFilter;
}

// ─────────────────────────────────────────────────────────────────────────
// Outcome observer — companion to the filter. Called by the runner
// once a turn completes so the FeedbackCollector can backfill shadow
// rows with what tools the agent actually invoked.
// ─────────────────────────────────────────────────────────────────────────

export type ToolSelectionOutcomeObserver = (
  taskText: string,
  toolsCalled: ReadonlyArray<string>,
  sessionId?: SessionId,
) => void;

let globalObserver: ToolSelectionOutcomeObserver | undefined;

export function setGlobalToolSelectionOutcomeObserver(fn: ToolSelectionOutcomeObserver | undefined): void {
  globalObserver = fn;
}

export function getGlobalToolSelectionOutcomeObserver(): ToolSelectionOutcomeObserver | undefined {
  return globalObserver;
}
