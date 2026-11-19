/**
 * Background notices: facts that changed while the model was doing other
 * work (e.g. a persistent command that exited after it yielded `running`).
 *
 * Without this channel the model must spend a full inference round on a
 * status poll just to learn that a process finished. Sources register here at
 * module load; the dispatcher drains them once per tool batch and appends the
 * text to that batch's last tool result, so the fact reaches the model with
 * the work it was already doing. Text is appended (never reordered), keeping
 * the cached transcript prefix intact.
 *
 * Module-level by design: the producers (e.g. the exec_command process
 * registry) are module-level singletons in the same JS realm.
 */
import type { ToolContext } from './tool.js';

/**
 * `runner` identifies the agent draining: subagents share the parent's
 * session id, so producers must deliver a notice only to the agent that is
 * waiting for it (the one that was told the work was still running).
 */
export type BackgroundNoticeContext = Pick<ToolContext, 'sessionId' | 'projectName' | 'cwd' | 'runner'>;

/** Returns zero or more self-contained notices and marks them delivered. */
export type BackgroundNoticeSource = (ctx: BackgroundNoticeContext) => string[];

const sources = new Set<BackgroundNoticeSource>();

export function registerBackgroundNoticeSource(source: BackgroundNoticeSource): () => void {
  sources.add(source);
  return () => { sources.delete(source); };
}

/** Collect pending notices for this owner, or null when there is nothing new. */
export function drainBackgroundNotices(ctx: BackgroundNoticeContext): string | null {
  const notices: string[] = [];
  for (const source of sources) {
    try {
      notices.push(...source(ctx));
    } catch {
      // A broken producer must never fail the tool batch that carries it.
    }
  }
  return notices.length > 0 ? notices.join('\n\n') : null;
}
