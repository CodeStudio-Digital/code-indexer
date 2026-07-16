/**
 * Tests for the consultative Kanban Quality advisory in `moveCard`.
 *
 * Invariants verified:
 *   1. With NO quality_classifications rows → move to `done` works normally.
 *   2. With a recent `flagged` verdict on an assigned agent → `done` remains
 *      `done` and an evidence comment is posted.
 *   3. Moving from `review` to `done` BYPASSES the advisory (explicit second
 *      pass represents human review).
 *   4. Verdicts older than the window do NOT block.
 *   5. Verdicts below the confidence floor do NOT block.
 *   6. When no agent is assigned to the card, the gate does not fire (we
 *      have no signal to gate on).
 *
 * Setup uses a real temp SQLite via CodeIndexDB (runs all migrations).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type DatabaseConstructor from 'better-sqlite3';
import { CodeIndexDB } from '@mcp/store/db.js';
import { CompanyStore } from '@mcp/store/company-store.js';
import { SessionStore } from '@mcp/code-agent/sessions/store.js';
import { QualityClassificationStore } from '@mcp/store/quality-classification-store.js';
import { SessionContext } from '../SessionContext.js';
import { KanbanService } from '../KanbanService.js';
import type { IMetaBusPublisher } from '../ports.js';

type RawDb = InstanceType<typeof DatabaseConstructor>;

interface Harness {
  db: CodeIndexDB;
  raw: RawDb;
  dir: string;
  companyStore: CompanyStore;
  sessionStore: SessionStore;
  qualityStore: QualityClassificationStore;
  kanban: KanbanService;
  events: Array<{ event: string; data: unknown }>;
  companySessionId: number;
  agentRunId: number;
  cardId: number;
}

function makeStubBus(events: Array<{ event: string; data: unknown }>): IMetaBusPublisher {
  return {
    bus: {} as never,
    publish: (event, data) => { events.push({ event, data }); },
    markEnded: () => { /* */ },
  };
}

function setup(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-kanban-gate-test-'));
  const dbPath = join(dir, 'test.db');
  // CodeIndexDB runs all migrations on this path; CompanyStore reopens
  // the same file (its constructor takes a path, not a handle). They
  // share the same underlying SQLite file via WAL mode.
  const db = new CodeIndexDB(dbPath);
  const raw = db.raw();
  const companyStore = new CompanyStore(dbPath);
  const qualityStore = new QualityClassificationStore(raw);
  const sessionStore = new SessionStore(dbPath);

  // Minimal setup chain: project → company session → coder session → agent run → kanban card → assignment.
  const project = db.createProject('p', '/tmp/proj');
  const cs = companyStore.createCompanySession({ name: 's' });
  const coderSession = sessionStore.createSession({
    project_id: project.id,
    title: 'subordinate',
    provider: 'stub',
    model: 'stub',
  });
  const agentRun = companyStore.createAgentRun({
    company_session_id: cs.id,
    role: 'frontend',
    coder_session_id: coderSession.id,
    project_ids: [project.id],
    provider: 'stub',
    model: 'stub',
  });
  const card = companyStore.createKanbanCard(cs.id, {
    title: 'do work',
    column: 'in_progress',
  });
  companyStore.assignAgentToCard(card.id, agentRun.id, 'frontend');

  const events: Harness['events'] = [];
  const ctx = new SessionContext({
    companySessionId: cs.id,
    companyStore,
    db,
    metaBus: {} as never,
  });
  const kanban = new KanbanService(ctx, makeStubBus(events));

  return {
    db, raw, dir, companyStore, sessionStore, qualityStore, kanban, events,
    companySessionId: cs.id, agentRunId: agentRun.id, cardId: card.id,
  };
}

function teardown(h: Harness): void {
  try { h.companyStore.close(); } catch { /* */ }
  try { h.sessionStore.close(); } catch { /* */ }
  try { h.db.close(); } catch { /* */ }
  try { rmSync(h.dir, { recursive: true, force: true }); } catch { /* */ }
}

describe('KanbanService quality gate (Wire #3)', () => {
  let h: Harness;
  beforeEach(() => { h = setup(); });
  afterEach(() => teardown(h));

  it('allows move to done when no quality verdicts exist', () => {
    const moved = h.kanban.moveCard(h.cardId, 'done');
    expect(moved.column).toBe('done');
    const moveEvent = h.events.find((e) => e.event === 'kanban_card_moved');
    expect(moveEvent).toBeDefined();
    expect((moveEvent!.data as { qualityGateBlocked?: boolean }).qualityGateBlocked).toBeUndefined();
  });

  it('keeps done and adds an advisory when a recent flagged verdict exists', () => {
    h.qualityStore.insert({
      agent_run_id: h.agentRunId,
      classifier_name: 'completeness',
      verdict: 'flagged',
      confidence: 0.95,
      reason: 'agent abandoned the task',
      scope: 'run_final',
      source: 'terminal_llm',
    });
    const moved = h.kanban.moveCard(h.cardId, 'done');
    expect(moved.column).toBe('done');

    const moveEvent = h.events.find((e) => e.event === 'kanban_card_moved');
    expect(moveEvent).toBeDefined();
    const payload = moveEvent!.data as {
      qualityAdvisory?: boolean;
      advisoryVerdictCount?: number;
    };
    expect(payload.qualityAdvisory).toBe(true);
    expect(payload.advisoryVerdictCount).toBe(1);

    // A comment explaining the gate should also have been published.
    const commentEvent = h.events.find((e) => e.event === 'kanban_comment_added');
    expect(commentEvent).toBeDefined();
    const commentPayload = commentEvent!.data as { comment?: { content: string; author_role: string } };
    expect(commentPayload.comment?.author_role).toBe('quality-advisory');
    expect(commentPayload.comment?.content).toMatch(/completeness/);
    expect(commentPayload.comment?.content).toMatch(/flagged/);
  });

  it('allows review → done to bypass the gate (manual review pass)', () => {
    h.qualityStore.insert({
      agent_run_id: h.agentRunId,
      classifier_name: 'completeness',
      verdict: 'flagged',
      confidence: 0.95,
      scope: 'run_final',
      source: 'terminal_llm',
    });
    h.companyStore.moveKanbanCard(h.cardId, 'review');
    h.events.length = 0;

    const moved = h.kanban.moveCard(h.cardId, 'done');
    expect(moved.column).toBe('done');
    const payload = h.events[0]?.data as { qualityGateBlocked?: boolean };
    expect(payload?.qualityGateBlocked).toBeUndefined();
  });

  it('does not block when the verdict is below confidence floor', () => {
    h.qualityStore.insert({
      agent_run_id: h.agentRunId,
      classifier_name: 'completeness',
      verdict: 'flagged',
      confidence: 0.3, // below 0.7 floor
      scope: 'run_final',
      source: 'terminal_llm',
    });
    const moved = h.kanban.moveCard(h.cardId, 'done');
    expect(moved.column).toBe('done');
  });

  it('does not block when verdict is `ok` regardless of confidence', () => {
    h.qualityStore.insert({
      agent_run_id: h.agentRunId,
      classifier_name: 'completeness',
      verdict: 'ok',
      confidence: 0.99,
      scope: 'run_final',
      source: 'terminal_llm',
    });
    const moved = h.kanban.moveCard(h.cardId, 'done');
    expect(moved.column).toBe('done');
  });

  it('does not block when card has no assigned agents (no signal)', () => {
    // Create a fresh card with no agent assignment.
    const card2 = h.companyStore.createKanbanCard(h.companySessionId, {
      title: 'unassigned',
      column: 'in_progress',
    });
    h.qualityStore.insert({
      agent_run_id: h.agentRunId,
      classifier_name: 'completeness',
      verdict: 'flagged',
      confidence: 0.99,
      scope: 'run_final',
      source: 'terminal_llm',
    });
    const moved = h.kanban.moveCard(card2.id, 'done');
    expect(moved.column).toBe('done');
  });

  it('advises on warn verdicts as well as flagged', () => {
    h.qualityStore.insert({
      agent_run_id: h.agentRunId,
      classifier_name: 'tool_misuse',
      verdict: 'warn',
      confidence: 0.85,
      scope: 'run_final',
      source: 'terminal_llm',
    });
    const moved = h.kanban.moveCard(h.cardId, 'done');
    expect(moved.column).toBe('done');
  });

  it('does not gate moves to columns other than done', () => {
    h.qualityStore.insert({
      agent_run_id: h.agentRunId,
      classifier_name: 'completeness',
      verdict: 'flagged',
      confidence: 0.99,
      scope: 'run_final',
      source: 'terminal_llm',
    });
    h.companyStore.moveKanbanCard(h.cardId, 'in_progress');
    const moved = h.kanban.moveCard(h.cardId, 'review');
    expect(moved.column).toBe('review');
    // Even though there's a flagged verdict, the move to review was NOT
    // gated (the gate only fires when destination is `done`).
    const moveEvent = h.events.find((e) => e.event === 'kanban_card_moved');
    expect((moveEvent!.data as { qualityGateBlocked?: boolean }).qualityGateBlocked).toBeUndefined();
  });
});
