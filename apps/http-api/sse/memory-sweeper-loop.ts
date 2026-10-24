/**
 * Idle memory sweeper — the "session went quiet" distill moment.
 *
 * Candidate discovery, transcript boundaries, retry state and diagnostics are
 * filesystem-backed. Durable project memory itself remains an intentionally
 * shared project/global catalog.
 */
import { createCoderProvider } from '@mcp/services/providers/factory.js';
import type { SessionId, SessionState } from '@mcp/session-storage';
import { summarizeSpanV2 } from '@mcp/code-agent/core/summarizer.js';
import { buildHarvestInput } from '@mcp/code-agent/core/runner/compaction/memory-harvest.js';
import { type StartMemorySweeperArgs, type MemorySweeperHandle, DEFAULT_INTERVAL_MS, DEFAULT_IDLE_AFTER_MS, DEFAULT_MAX_PER_SWEEP, DEFAULT_MAX_CANDIDATES_INSPECTED, MAX_UNCHANGED_SESSION_MARKERS, type MemorySweepCandidate, record, nonNegativeInteger, MAX_DISTILL_ATTEMPTS, MIN_SPAN_MESSAGES, withTimeout, STEP_TIMEOUT_MS } from './memory-sweeper-policy.js';

export function startMemorySweeper(args: StartMemorySweeperArgs): MemorySweeperHandle {
  const intervalMs = args.intervalMs ?? DEFAULT_INTERVAL_MS;
  const idleAfterMs = args.idleAfterMs ?? DEFAULT_IDLE_AFTER_MS;
  const maxPerSweep = args.maxPerSweep ?? DEFAULT_MAX_PER_SWEEP;
  const maxCandidatesInspected = Math.max(
    maxPerSweep,
    args.maxCandidatesInspected ?? DEFAULT_MAX_CANDIDATES_INSPECTED,
  );
  let candidateScanCursor = 0;
  const makeProvider = args.providerFactory ?? createCoderProvider;
  const isSessionActive = args.isSessionActive ?? (() => false);
  const { sessionStore, db, runEndMemory, agentMemoryService } = args;

  let stopped = false;
  let inFlight = false;
  // A quiet session whose durable projection did not change cannot gain new
  // conversation records. Remember no-op checks so the five-minute timer does
  // not reopen even the small JSONL tail forever. Bound the map explicitly:
  // historical session catalogs can be large and this cache is only a hint.
  const unchangedSessionMarkers = new Map<string, string>();

  const rememberUnchanged = (sessionId: SessionId, marker: string): void => {
    const key = String(sessionId);
    unchangedSessionMarkers.delete(key);
    unchangedSessionMarkers.set(key, marker);
    while (unchangedSessionMarkers.size > MAX_UNCHANGED_SESSION_MARKERS) {
      const oldest = unchangedSessionMarkers.keys().next().value;
      if (oldest === undefined) break;
      unchangedSessionMarkers.delete(oldest);
    }
  };

  const runRelationalWrite = async <T>(operation: () => T): Promise<T> =>
    agentMemoryService
      ? agentMemoryService.runRelationalWrite(operation)
      : operation();

  const appendDistillEvent = async (
    candidate: Pick<MemorySweepCandidate, 'session_id' | 'project_id'>,
    status: 'error' | 'skipped',
    detail: string,
    error?: string,
  ): Promise<void> => {
    await sessionStore.appendSessionEvent(
      candidate.session_id,
      'memory_distill',
      {
        trigger: 'idle',
        status,
        detail,
        project_id: candidate.project_id,
        error: error ?? null,
        at: new Date().toISOString(),
      },
    );
  };

  const settleSpan = async (
    sessionId: SessionId,
    maxSeq: number,
  ): Promise<void> => {
    try {
      await sessionStore.setMemoryDistilledBoundary(sessionId, maxSeq);
      await sessionStore.resetMemoryDistillAttempts(sessionId);
    } catch {
      // The next sweep retries. Each state.json mutation is itself atomic.
    }
  };

  const recordFailure = async (
    candidate: MemorySweepCandidate,
    detail: string,
    message: string,
  ): Promise<void> => {
    try {
      await sessionStore.bumpMemoryDistillAttempts(candidate.session_id);
      await appendDistillEvent(candidate, 'error', detail, message);
    } catch {
      // Diagnostics must not abort the project-memory sweep.
    }
  };

  const listCandidates = async (): Promise<MemorySweepCandidate[]> => {
    // Repository events keep newly-created host sessions in the shared
    // catalog. A forced refresh here used to crawl every registered project
    // root and every bundle on each five-minute tick. Rank the cheap cached
    // projections, then authoritatively re-read only old Coder candidates.
    await sessionStore.ensureCatalog();
    const now = Date.now();
    const entries = sessionStore.catalog
      .list()
      .filter(
        (entry) =>
          entry.session.kind === 'coder' &&
          entry.session.owner_project_id != null &&
          !isSessionActive(entry.session.id),
      )
      .filter((entry) => {
        const cachedUpdatedAt = Math.max(
          Date.parse(entry.session.updated_at),
          Date.parse(entry.state?.updated_at ?? entry.session.updated_at),
        );
        return (
          !Number.isFinite(cachedUpdatedAt) ||
          now - cachedUpdatedAt >= idleAfterMs
        );
      })
      .sort((left, right) => {
        const leftTime = Math.max(
          Date.parse(left.session.updated_at),
          Date.parse(left.state?.updated_at ?? left.session.updated_at),
        );
        const rightTime = Math.max(
          Date.parse(right.session.updated_at),
          Date.parse(right.state?.updated_at ?? right.session.updated_at),
        );
        return (
          leftTime - rightTime ||
          String(left.session.id).localeCompare(String(right.session.id))
        );
      });

    const pending: MemorySweepCandidate[] = [];
    const scanStart = entries.length > 0
      ? candidateScanCursor % entries.length
      : 0;
    let inspected = 0;
    while (
      inspected < entries.length
      && inspected < maxCandidatesInspected
    ) {
      const entry = entries[(scanStart + inspected) % entries.length]!;
      inspected += 1;
      // Host writes update the shared catalog. Only a non-idle/missing cached
      // state can require one authoritative read to observe that an external
      // worker has finished. Cached idle entries need no synchronous I/O; the
      // live-worker guard above remains the authority for active work.
      let state: SessionState | null = entry.state;
      if (!state || state.status !== 'idle') {
        try {
          state = sessionStore.repository.readStateSync(entry.location);
        } catch {
          continue;
        }
      }
      const projectId = entry.session.owner_project_id;
      if (state.status !== 'idle' || projectId == null) continue;
      try {
        if (!db.getProjectMemoryEnabled(projectId)) continue;
      } catch {
        continue;
      }

      const runtime = record(state.extra.runtime);
      const attempts = nonNegativeInteger(runtime.memory_distill_attempts);
      const updatedAtMs = Math.max(
        Date.parse(entry.session.updated_at),
        Date.parse(state.updated_at),
      );
      if (
        !Number.isFinite(updatedAtMs)
        || now - updatedAtMs < idleAfterMs * (1 + attempts)
      ) {
        continue;
      }
      const candidate: MemorySweepCandidate = {
        session_id: entry.session.id,
        project_id: projectId,
        provider: entry.session.provider ?? '',
        model: entry.session.model ?? '',
        distilled_mark: nonNegativeInteger(runtime.memory_distilled_seq),
        attempts,
        updated_at_ms: updatedAtMs,
      };
      const unchangedMarker = [
        entry.session.updated_at,
        state.updated_at,
        candidate.distilled_mark,
        candidate.attempts,
      ].join(':');
      if (
        unchangedSessionMarkers.get(String(candidate.session_id))
        === unchangedMarker
      ) {
        continue;
      }
      if (
        await sessionStore.maxMessageSeq(candidate.session_id)
        <= candidate.distilled_mark
      ) {
        rememberUnchanged(candidate.session_id, unchangedMarker);
        continue;
      }
      unchangedSessionMarkers.delete(String(candidate.session_id));
      pending.push(candidate);
      if (pending.length >= maxPerSweep) break;
    }
    candidateScanCursor = entries.length > 0
      ? (scanStart + inspected) % entries.length
      : 0;
    return pending;
  };

  const sweepSession = async (
    candidate: MemorySweepCandidate,
  ): Promise<boolean> => {
    const span = await sessionStore.listMessagesAfter(
      candidate.session_id,
      candidate.distilled_mark,
    );
    if (span.messages.length === 0) return false;
    if (candidate.attempts >= MAX_DISTILL_ATTEMPTS) {
      await settleSpan(candidate.session_id, span.maxSeq);
      await appendDistillEvent(
        candidate,
        'skipped',
        'retry_cap',
        `gave up after ${candidate.attempts} failed distill attempts`,
      ).catch(() => undefined);
      return false;
    }
    if (span.messages.length < MIN_SPAN_MESSAGES) {
      await settleSpan(candidate.session_id, span.maxSeq);
      return false;
    }

    try {
      const provider = await makeProvider(candidate.provider, candidate.model);
      const summary = await withTimeout(
        summarizeSpanV2(span.messages, provider),
        STEP_TIMEOUT_MS,
      );
      if (!summary) {
        await recordFailure(
          candidate,
          'summarizer_timeout',
          'summarizer returned no result',
        );
        return false;
      }
      const [trail, succeeded, notes] = await Promise.all([
        sessionStore.getCommandTrail(candidate.session_id),
        sessionStore.didRunSucceed(candidate.session_id),
        sessionStore.listSessionMemory(candidate.session_id),
      ]);
      const input = buildHarvestInput({
        summary,
        trail,
        succeeded,
        notes,
        trigger: 'idle',
        sessionId: candidate.session_id,
      });
      const projectName = db.getProject(candidate.project_id)?.name ?? '';
      const persist = () =>
        Promise.resolve(
          runEndMemory.extractAndPersist(
            candidate.project_id,
            projectName,
            input,
          ),
        );
      const result = await withTimeout(
        agentMemoryService
          ? agentMemoryService.runMutationBatch(persist)
          : persist(),
        STEP_TIMEOUT_MS,
      );
      if (result === undefined) {
        await recordFailure(
          candidate,
          'extract_timeout',
          `extract exceeded ${STEP_TIMEOUT_MS}ms`,
        );
        return false;
      }
      if (result?.hadError) {
        await sessionStore.bumpMemoryDistillAttempts(candidate.session_id)
          .catch(() => undefined);
        return false;
      }
      await settleSpan(candidate.session_id, span.maxSeq);
      return true;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      console.warn(
        `[memory/sweeper] session ${candidate.session_id} failed: ${message}`,
      );
      await recordFailure(candidate, 'sweep_error', message);
      return false;
    }
  };

  const runOnce = async (): Promise<number> => {
    if (stopped || inFlight) return 0;
    inFlight = true;
    const activityToken = args.enterBackgroundActivity?.('memory-sweeper');
    try {
      const candidates = await listCandidates();
      if (candidates.length === 0) return 0;
      if (!(await runEndMemory.isConfigured())) return 0;
      let distilled = 0;
      for (const candidate of candidates) {
        if (stopped) break;
        if (await sweepSession(candidate)) distilled += 1;
      }
      if (distilled > 0) {
        console.log(
          `[memory/sweeper] swept — distilled=${distilled}/${candidates.length} idle session(s)`,
        );
      }

      // Project/user memory hygiene remains in the shared durable-memory
      // catalog. It never reads or writes a session table.
      try {
        const projects = new Set(
          candidates.map((candidate) => candidate.project_id),
        );
        let archived = 0;
        let decayed = 0;
        for (const projectId of projects) {
          if (!db.hasAgentMemoryHygieneCandidates('project', projectId)) {
            continue;
          }
          const hygiene = () => ({
            consolidated:
              db.consolidateAgentMemory('project', projectId).archived,
            decayed: db.decayColdAgentMemoryNotes('project', projectId),
          });
          const result = agentMemoryService
            ? await agentMemoryService.runScopeMutationAsync(
                'project',
                projectId,
                hygiene,
              )
            : await runRelationalWrite(() => db.transaction(hygiene));
          archived += result.consolidated;
          decayed += result.decayed;
        }
        const userArchived = db.hasAgentMemoryHygieneCandidates('user', 0)
          ? agentMemoryService
            ? await agentMemoryService.runScopeMutationAsync(
                'user',
                0,
                () => db.consolidateAgentMemory('user', 0).archived,
              )
            : await runRelationalWrite(
                () => db.consolidateAgentMemory('user', 0).archived,
              )
          : 0;
        archived += userArchived;
        const prunedEvents = await runRelationalWrite(
          () => db.pruneAgentMemoryEvents(),
        );
        if (archived > 0 || decayed > 0 || prunedEvents > 0) {
          console.log(
            `[memory/sweeper] hygiene — archived=${archived} dup memories, ` +
            `decayed=${decayed} cold notes, pruned=${prunedEvents} events`,
          );
        }
      } catch (error) {
        console.warn(
          `[memory/sweeper] hygiene failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return distilled;
    } catch (error) {
      console.warn(
        `[memory/sweeper] sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    } finally {
      try {
        if (activityToken !== undefined) {
          args.exitBackgroundActivity?.(activityToken);
        }
      } catch {
        // Performance attribution must never wedge the functional sweep.
      } finally {
        inFlight = false;
      }
    }
  };

  const timer = setInterval(() => {
    void runOnce();
  }, intervalMs);
  timer.unref?.();

  console.log(
    `[memory/sweeper] started — interval=${Math.round(intervalMs / 1000)}s ` +
    `idleAfter=${Math.round(idleAfterMs / 1000)}s maxPerSweep=${maxPerSweep}`,
  );

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      unchangedSessionMarkers.clear();
      console.log('[memory/sweeper] stopped');
    },
    runOnce,
    intervalMs,
    idleAfterMs,
  };
}
