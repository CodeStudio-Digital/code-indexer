/**
 * Tests for the Kanban Dependency Gate in `KanbanService.moveCard`.
 *
 * Invariants verified:
 *   1. A card with an OPEN blocker (a `depends_on` card not in `done`) cannot
 *      advance into `in_progress` — the move is refused (snapped back to its
 *      current column) and a `dependency-gate` comment is posted.
 *   2. The blocking move publishes `dependencyBlocked: true` + `blockingCardIds`.
 *   3. Once the blocker reaches `done`, the dependent card moves freely.
 *   4. A card with NO dependencies is unaffected.
 *   5. Reorders within the SAME active column are not gated.
 *   6. Advancing to `review`/`done` is also gated while a blocker is open.
 *
 * Setup uses a real temp SQLite via CodeIndexDB (runs all migrations).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import { CompanyStore } from '@mcp/store/company-store.js';
import { SessionContext } from '../SessionContext.js';
import { KanbanService } from '../KanbanService.js';
import type { IMetaBusPublisher } from '../ports.js';

interface Harness {
  db: CodeIndexDB;
  dir: string;
  companyStore: CompanyStore;
  kanban: KanbanService;
  events: Array<{ event: string; data: unknown }>;
  companySessionId: number;
  blockerId: number;
  dependentId: number;
}

function makeStubBus(events: Array<{ event: string; data: unknown }>): IMetaBusPublisher {
  return {
    bus: {} as never,
    publish: (event, data) => { events.push({ event, data }); },
    markEnded: () => { /* */ },
  };
}

function setup(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-kanban-dep-test-'));
  const dbPath = join(dir, 'test.db');
  const db = new CodeIndexDB(dbPath);
  const companyStore = new CompanyStore(dbPath);

  db.createProject('p', '/tmp/proj');
  const cs = companyStore.createCompanySession({ name: 's' });
  // Blocker starts in todo (not done) → it blocks. Dependent starts in todo.
  const blocker = companyStore.createKanbanCard(cs.id, { title: 'blocker', column: 'todo' });
  const dependent = companyStore.createKanbanCard(cs.id, { title: 'dependent', column: 'todo' });
  companyStore.addCardDependency(dependent.id, blocker.id);

  const events: Harness['events'] = [];
  const ctx = new SessionContext({
    companySessionId: cs.id,
    companyStore,
    db,
    metaBus: {} as never,
  });
  const kanban = new KanbanService(ctx, makeStubBus(events));

  return { db, dir, companyStore, kanban, events, companySessionId: cs.id, blockerId: blocker.id, dependentId: dependent.id };
}

function teardown(h: Harness): void {
  try { h.companyStore.close(); } catch { /* */ }
  try { h.db.close(); } catch { /* */ }
  try { rmSync(h.dir, { recursive: true, force: true }); } catch { /* */ }
}

describe('KanbanService dependency gate', () => {
  let h: Harness;
  beforeEach(() => { h = setup(); });
  afterEach(() => teardown(h));

  it('refuses to advance a card with an open blocker into in_progress', () => {
    const moved = h.kanban.moveCard(h.dependentId, 'in_progress');
    // Snapped back to its current column (todo), NOT in_progress.
    expect(moved.column).toBe('todo');

    const moveEvent = h.events.find((e) => e.event === 'kanban_card_moved');
    const payload = moveEvent!.data as {
      requestedColumn?: string;
      dependencyBlocked?: boolean;
      blockingCardIds?: number[];
      toColumn?: string;
    };
    expect(payload.dependencyBlocked).toBe(true);
    expect(payload.requestedColumn).toBe('in_progress');
    expect(payload.toColumn).toBe('todo');
    expect(payload.blockingCardIds).toEqual([h.blockerId]);

    const commentEvent = h.events.find((e) => e.event === 'kanban_comment_added');
    const comment = commentEvent!.data as { comment?: { content: string; author_role: string } };
    expect(comment.comment?.author_role).toBe('dependency-gate');
    expect(comment.comment?.content).toMatch(/blocker/);
  });

  it('also gates advancing to review/done while a blocker is open', () => {
    const toReview = h.kanban.moveCard(h.dependentId, 'review');
    expect(toReview.column).toBe('todo');
    const toDone = h.kanban.moveCard(h.dependentId, 'done');
    expect(toDone.column).toBe('todo');
  });

  it('allows the move once the blocker reaches done', () => {
    h.companyStore.moveKanbanCard(h.blockerId, 'done');
    const moved = h.kanban.moveCard(h.dependentId, 'in_progress');
    expect(moved.column).toBe('in_progress');
    const blockedEvent = h.events.find(
      (e) => (e.data as { dependencyBlocked?: boolean }).dependencyBlocked === true,
    );
    expect(blockedEvent).toBeUndefined();
  });

  it('does not gate a card with no dependencies', () => {
    const free = h.companyStore.createKanbanCard(h.companySessionId, { title: 'free', column: 'todo' });
    const moved = h.kanban.moveCard(free.id, 'in_progress');
    expect(moved.column).toBe('in_progress');
  });

  it('does not gate a reorder within the same active column', () => {
    // Put the dependent in in_progress directly (bypassing the gate), then a
    // same-column "move" must not be refused even though a blocker is open.
    h.companyStore.moveKanbanCard(h.dependentId, 'in_progress');
    const moved = h.kanban.moveCard(h.dependentId, 'in_progress', 0);
    expect(moved.column).toBe('in_progress');
    const blockedEvent = h.events.find(
      (e) => (e.data as { dependencyBlocked?: boolean }).dependencyBlocked === true,
    );
    expect(blockedEvent).toBeUndefined();
  });
});
