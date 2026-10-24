import type { StreamBlock } from './types.js';

/** Terminal state to stamp on visualizations the run left behind. */
type LiveRunOutcome = 'completed' | 'aborted' | 'failed';

/**
 * Presentation-only blocks (activity/task_run/workflow) carry no durable identity,
 * so live⇄persisted reconciliation can only pass through them once they are
 * terminal. Nothing else ends them reliably: the `*_run_finished` events only
 * arrive when the tool itself reports back, and `clearProviderActivities` needs a
 * following text/thinking/tool frame that a finished run no longer produces. Left
 * `running`, they keep the live turn pinned on screen and the persisted copy
 * suppressed — the transcript then shows the live copy only, permanently.
 *
 * Returns true when at least one block changed.
 */
export function finalizeLiveVisualizations(
  blocks: StreamBlock[],
  outcome: LiveRunOutcome,
): boolean {
  const finishedAt = new Date().toISOString();
  let changed = false;

  for (const block of blocks) {
    if (block.type === 'activity') {
      if (block.status !== 'running') continue;
      block.status = outcome;
      changed = true;
      continue;
    }
    if (block.type === 'task_run' || block.type === 'workflow') {
      if (block.run.status !== 'running') continue;
      block.run.status = outcome;
      block.run.finishedAt ??= finishedAt;
      changed = true;
    }
  }

  return changed;
}

/** Maps a `done` reason onto the terminal state its leftovers deserve. */
export function outcomeForDoneReason(reason: string): LiveRunOutcome {
  return reason === 'completed' ? 'completed' : 'aborted';
}
