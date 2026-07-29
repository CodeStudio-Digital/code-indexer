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
 * Setup keeps only the essential project catalog in SQLite. All Company
 * session and kanban state lives in the filesystem bundle.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsSessionStore } from '@mcp/code-agent/sessions/fs-store/fs-session-store.js';
import {
  SessionLocator,
  asCompanySessionId,
  type JsonValue,
} from '@mcp/session-storage';
import { CompanySessionFiles } from '../CompanySessionFiles.js';
import { SessionContext } from '../SessionContext.js';
import { KanbanService } from '../KanbanService.js';
import type { IMetaBusPublisher } from '../ports.js';

interface Harness {
  dir: string;
  companyFiles: CompanySessionFiles;
  kanban: KanbanService;
  events: Array<{ event: string; data: unknown }>;
  companySessionId: string;
  blockerId: string;
  dependentId: string;
}

function makeStubBus(events: Array<{ event: string; data: unknown }>): IMetaBusPublisher {
  return {
    bus: {} as never,
    publish: (event, data) => { events.push({ event, data }); },
    markEnded: () => { /* */ },
  };
}

async function setup(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-kanban-dep-test-'));
  const dataDir = join(dir, 'data');
  const projectRoot = join(dir, 'project');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  const project = { id: 7, root_path: projectRoot };
  const locator = new SessionLocator({
    dataDir,
    projectRootResolver: {
      resolveProjectRoot: (projectId) =>
        projectId === project.id ? projectRoot : null,
      listProjectRoots: () => [{
        project_id: project.id,
        root_path: projectRoot,
      }],
    },
  });
  const sessionStore = new FsSessionStore({ locator });
  const company = await sessionStore.repository.createSession({
    kind: 'company',
    scope: { kind: 'project', project_id: project.id },
    owner_project_id: project.id,
    linked_projects: [{ project_id: project.id, root_path: projectRoot }],
    title: 's',
    status: 'idle',
    metadata: {
      company: {
        name: 's',
        template_id: null,
        runtime_kind: 'company',
        config_json: '{}',
        master_session_id: null,
        project_labels: { [project.id]: null },
        recovered_at: null,
        recovered_reason: null,
      },
    } as unknown as Record<string, JsonValue>,
  });
  await sessionStore.refresh();
  const companySessionId = asCompanySessionId(company.session.id);
  const companyFiles = new CompanySessionFiles({
    companySessionId,
    sessionStore,
  });
  // Blocker starts in todo (not done) → it blocks. Dependent starts in todo.
  const blocker = companyFiles.createKanbanCardSync({
    title: 'blocker',
    column: 'todo',
  });
  const dependent = companyFiles.createKanbanCardSync({
    title: 'dependent',
    column: 'todo',
  });
  companyFiles.addKanbanDependencySync(dependent.id, blocker.id);

  const events: Harness['events'] = [];
  const ctx = new SessionContext({
    companySessionId,
    companyFiles,
    companyStore: {} as never,
    db: {} as never,
    metaBus: {} as never,
  });
  const kanban = new KanbanService(ctx, makeStubBus(events));

  return {
    dir,
    companyFiles,
    kanban,
    events,
    companySessionId,
    blockerId: blocker.id,
    dependentId: dependent.id,
  };
}

function teardown(h: Harness): void {
  try { rmSync(h.dir, { recursive: true, force: true }); } catch { /* */ }
}

describe('KanbanService dependency gate', () => {
  let h: Harness;
  beforeEach(async () => { h = await setup(); });
  afterEach(() => teardown(h));

  it('refuses to advance a card with an open blocker into in_progress', () => {
    const moved = h.kanban.moveCard(h.dependentId, 'in_progress');
    // Snapped back to its current column (todo), NOT in_progress.
    expect(moved.column).toBe('todo');

    const moveEvent = h.events.find((e) => e.event === 'kanban_card_moved');
    const payload = moveEvent!.data as {
      requestedColumn?: string;
      dependencyBlocked?: boolean;
      blockingCardIds?: string[];
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
    h.companyFiles.moveKanbanCardSync(h.blockerId, 'done');
    const moved = h.kanban.moveCard(h.dependentId, 'in_progress');
    expect(moved.column).toBe('in_progress');
    const blockedEvent = h.events.find(
      (e) => (e.data as { dependencyBlocked?: boolean }).dependencyBlocked === true,
    );
    expect(blockedEvent).toBeUndefined();
  });

  it('does not gate a card with no dependencies', () => {
    const free = h.companyFiles.createKanbanCardSync({
      title: 'free',
      column: 'todo',
    });
    const moved = h.kanban.moveCard(free.id, 'in_progress');
    expect(moved.column).toBe('in_progress');
  });

  it('does not gate a reorder within the same active column', () => {
    // Put the dependent in in_progress directly (bypassing the gate), then a
    // same-column "move" must not be refused even though a blocker is open.
    h.companyFiles.moveKanbanCardSync(h.dependentId, 'in_progress');
    const moved = h.kanban.moveCard(h.dependentId, 'in_progress', 0);
    expect(moved.column).toBe('in_progress');
    const blockedEvent = h.events.find(
      (e) => (e.data as { dependencyBlocked?: boolean }).dependencyBlocked === true,
    );
    expect(blockedEvent).toBeUndefined();
  });
});
