/**
 * Per-`agentRunId` in-flight guard for subordinate resume/reactivate.
 *
 * Every resume path — inbox `drainOnIdle`, master `forward_to_agent`, the
 * `resume_subordinate` tool, and the completion-handler auto-retry — funnels
 * through `resumeSubordinate`, which calls `runCoder` on the agent's existing
 * `coder_session_id`. `runCoder` has NO concurrency guard, so two overlapping
 * resumes on the same agent_run would interleave writes to the same session →
 * turn-history corruption. The drain mutex only serialises drain↔drain; it
 * does not cover the drain-mutex timeout-reset path or a `forward_to_agent`
 * racing a drain.
 *
 * This guard closes all of those at the single choke point. A SYNCHRONOUS
 * check-and-add is the whole point: JS runs the synchronous prefix of an async
 * function to completion before yielding at the first `await`, so two
 * concurrent `resumeSubordinate(id)` calls cannot both acquire.
 */
const inFlight = new Set<string>();

/** Reserve the resume slot for `agentRunId`. Returns false if already held. */
export function tryAcquireResume(agentRunId: string): boolean {
  if (inFlight.has(agentRunId)) return false;
  inFlight.add(agentRunId);
  return true;
}

/** Release the resume slot for `agentRunId` (no-op if not held). */
export function releaseResume(agentRunId: string): void {
  inFlight.delete(agentRunId);
}

/** True when a resume is currently in flight for `agentRunId`. */
export function isResumeInFlight(agentRunId: string): boolean {
  return inFlight.has(agentRunId);
}
