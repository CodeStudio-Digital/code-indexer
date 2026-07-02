import { describe, it, expect, beforeEach } from 'vitest';
import {
  upsertBugCard,
  syncFeatureCard,
  renderBugTitle,
  renderBugDescription,
  renderRecurrenceComment,
  type KanbanBridgeDeps,
} from '@mcp/services/qa/kanban-bridge.js';
import type { QaRun, QaTestResult } from '@mcp/services/qa/types.js';

/**
 * Unit tests for the QA-Kanban bridge. Uses in-memory fakes so the
 * bridge can be exercised without a full DB or orchestrator. The fakes
 * expose just enough of `CompanyStore` + `IQaTestResultStore` to satisfy
 * the bridge's dependency surface — extending them later is mechanical.
 */

interface FakeCard {
  id: number;
  title: string;
  description: string;
  column: string;
  tag: string | null;
  comments: Array<{ author: string; content: string }>;
}

class FakeCompanyStore {
  cards = new Map<number, FakeCard>();
  dependencies: Array<{ card_id: number; depends_on_id: number }> = [];
  private nextId = 100;

  createKanbanCard(_sessionId: number, input: {
    title: string;
    description?: string;
    column?: string;
    tag?: string | null;
    created_by?: string;
  }): FakeCard {
    const card: FakeCard = {
      id: this.nextId++,
      title: input.title,
      description: input.description ?? '',
      column: input.column ?? 'backlog',
      tag: input.tag ?? null,
      comments: [],
    };
    this.cards.set(card.id, card);
    return card;
  }

  getKanbanCard(cardId: number): FakeCard | null {
    return this.cards.get(cardId) ?? null;
  }

  addKanbanComment(cardId: number, author: string, _runId: number | null, content: string): void {
    const card = this.cards.get(cardId);
    if (card) card.comments.push({ author, content });
  }

  addCardDependency(cardId: number, dependsOnId: number): void {
    this.dependencies.push({ card_id: cardId, depends_on_id: dependsOnId });
  }

  moveKanbanCard(cardId: number, column: string): FakeCard {
    const card = this.cards.get(cardId);
    if (!card) throw new Error(`card ${cardId} not found`);
    card.column = column;
    return card;
  }
}

class FakeQaResultStore {
  byTest = new Map<string, QaTestResult>();
  stamps = new Map<number, number | null>();

  findRecentResultByName(opts: { spec_file: string; test_name: string }): QaTestResult | null {
    const key = `${opts.spec_file}::${opts.test_name}`;
    return this.byTest.get(key) ?? null;
  }

  setKanbanCardId(resultId: number, cardId: number | null): void {
    this.stamps.set(resultId, cardId);
  }
}

function makeDeps(
  companyStore: FakeCompanyStore,
  qaResultStore: FakeQaResultStore,
): KanbanBridgeDeps {
  return {
    companyStore: companyStore as unknown as KanbanBridgeDeps['companyStore'],
    qaResultStore: qaResultStore as unknown as KanbanBridgeDeps['qaResultStore'],
  };
}

function makeRun(over: Partial<QaRun> = {}): QaRun {
  return {
    id: 11,
    company_session_id: 7,
    agent_run_id: null,
    suite: 'login',
    service_id: 'main',
    status: 'completed',
    started_at: '2026-04-25 10:00:00',
    completed_at: '2026-04-25 10:01:00',
    passed: 0,
    failed: 1,
    skipped: 0,
    duration_ms: 60000,
    trigger: 'agent',
    report_persisted_path: null,
    kanban_feature_card_id: null,
    last_error: null,
    error_class: null,
    last_event_at: null,
    plan_gate: null,
    ...over,
  };
}

function makeResult(over: Partial<QaTestResult> = {}): QaTestResult {
  return {
    id: 99,
    run_id: 11,
    spec_file: 'tests/e2e/login.spec.ts',
    test_name: 'wrong password keeps the form',
    status: 'failed',
    duration_ms: 1500,
    error: 'Expected text not visible',
    trace_path: 'test-results/login/trace.zip',
    screenshot_path: 'test-results/login/screenshot.png',
    video_path: 'test-results/login/video.webm',
    summary_md_path: 'test-results/login/summary.md',
    kanban_card_id: null,
    created_at: '2026-04-25 10:00:30',
    ...over,
  };
}

describe('upsertBugCard', () => {
  let companyStore: FakeCompanyStore;
  let qaResultStore: FakeQaResultStore;
  beforeEach(() => {
    companyStore = new FakeCompanyStore();
    qaResultStore = new FakeQaResultStore();
  });

  it('creates a new bug card on first failure and stamps the result', () => {
    const run = makeRun();
    const result = makeResult();
    const out = upsertBugCard(
      makeDeps(companyStore, qaResultStore),
      {
        sessionId: 7,
        run,
        result,
        buildEvidenceUrl: (p) => `/api/sessions/7/qa/artifact?path=${p}`,
        runDetailUrl: '/c/7?tab=tests&run=11',
      },
    );
    expect(out.created).toBe(true);
    expect(out.cardId).not.toBeNull();
    const card = companyStore.cards.get(out.cardId!);
    expect(card?.tag).toBe('bug');
    expect(card?.column).toBe('todo');
    expect(card?.title).toBe('[QA-BUG] login: wrong password keeps the form');
    expect(card?.description).toContain('Expected text not visible');
    expect(card?.description).toContain('test-results/login/video.webm');
    expect(qaResultStore.stamps.get(99)).toBe(out.cardId);
  });

  it('reuses the existing card when the same test fails again (idempotent)', () => {
    const run = makeRun();
    const result1 = makeResult({ id: 100 });
    const result2 = makeResult({ id: 101, error: 'Different message' });

    const first = upsertBugCard(
      makeDeps(companyStore, qaResultStore),
      {
        sessionId: 7,
        run,
        result: result1,
        buildEvidenceUrl: (p) => p,
      },
    );

    // Simulate the bridge stamp persisting back: the second call's
    // findRecentResultByName must return the prior result.
    qaResultStore.byTest.set(
      `${result1.spec_file}::${result1.test_name}`,
      { ...result1, kanban_card_id: first.cardId },
    );

    const second = upsertBugCard(
      makeDeps(companyStore, qaResultStore),
      {
        sessionId: 7,
        run,
        result: result2,
        buildEvidenceUrl: (p) => p,
      },
    );

    expect(second.created).toBe(false);
    expect(second.cardId).toBe(first.cardId);
    const card = companyStore.cards.get(first.cardId!);
    expect(card?.comments.length).toBe(1);
    expect(card!.comments[0].content).toContain('Failure recurred in run #11');
    expect(qaResultStore.stamps.get(101)).toBe(first.cardId);
  });

  it('links the bug card to the feature card via dependency', () => {
    const run = makeRun({ kanban_feature_card_id: 42 });
    const result = makeResult();
    const out = upsertBugCard(
      makeDeps(companyStore, qaResultStore),
      {
        sessionId: 7,
        run,
        result,
        buildEvidenceUrl: (p) => p,
      },
    );
    expect(companyStore.dependencies).toContainEqual({
      card_id: out.cardId,
      depends_on_id: 42,
    });
  });
});

describe('syncFeatureCard', () => {
  let companyStore: FakeCompanyStore;
  let qaResultStore: FakeQaResultStore;
  beforeEach(() => {
    companyStore = new FakeCompanyStore();
    qaResultStore = new FakeQaResultStore();
  });

  it('moves a card to done when all green', () => {
    companyStore.cards.set(50, {
      id: 50,
      title: 'QA: login',
      description: '',
      column: 'in_progress',
      tag: null,
      comments: [],
    });
    const run = makeRun({ passed: 3, failed: 0 });
    const out = syncFeatureCard(
      makeDeps(companyStore, qaResultStore),
      { featureCardId: 50, run, passed: 3, failed: 0, runDetailUrl: '/c/7' },
    );
    expect(out.column).toBe('done');
    expect(companyStore.cards.get(50)?.column).toBe('done');
    expect(companyStore.cards.get(50)?.comments[0].content).toContain('QA verde');
  });

  it('moves a card from done back to in_progress when red', () => {
    companyStore.cards.set(50, {
      id: 50,
      title: 'QA: login',
      description: '',
      column: 'done',
      tag: null,
      comments: [],
    });
    const run = makeRun({ passed: 2, failed: 1 });
    const out = syncFeatureCard(
      makeDeps(companyStore, qaResultStore),
      { featureCardId: 50, run, passed: 2, failed: 1, runDetailUrl: '/c/7' },
    );
    expect(out.column).toBe('in_progress');
    expect(companyStore.cards.get(50)?.comments[0].content).toContain('QA red');
  });

  it('does NOT move when card is missing — surfaces a warning instead', () => {
    const run = makeRun();
    const out = syncFeatureCard(
      makeDeps(companyStore, qaResultStore),
      { featureCardId: 9999, run, passed: 0, failed: 1 },
    );
    expect(out.column).toBeNull();
    expect(out.warnings.some((w) => w.includes('missing'))).toBe(true);
  });
});

describe('renderers', () => {
  it('renderBugTitle uses the suite + test name', () => {
    const run = makeRun({ suite: 'auth/forgot-password' });
    const result = makeResult({ test_name: 'sends email when address is valid' });
    expect(
      renderBugTitle({
        sessionId: 1,
        run,
        result,
        buildEvidenceUrl: () => '',
      }),
    ).toBe('[QA-BUG] auth/forgot-password: sends email when address is valid');
  });

  it('renderBugDescription includes evidence URLs and run id', () => {
    const run = makeRun();
    const result = makeResult();
    const desc = renderBugDescription({
      sessionId: 7,
      run,
      result,
      buildEvidenceUrl: (p) => `/x/${p}`,
      runDetailUrl: '/c/7?run=11',
    });
    expect(desc).toContain('/x/test-results/login/video.webm');
    expect(desc).toContain('/x/test-results/login/screenshot.png');
    expect(desc).toContain('/x/test-results/login/summary.md');
    expect(desc).toContain('run #11');
    expect(desc).toContain('/c/7?run=11');
  });

  it('renderRecurrenceComment quotes the first line of the error', () => {
    const run = makeRun({ id: 7 });
    const result = makeResult({ error: 'first line\nignored detail' });
    const c = renderRecurrenceComment({
      sessionId: 1,
      run,
      result,
      buildEvidenceUrl: () => '',
    });
    expect(c).toContain('first line');
    expect(c).not.toContain('ignored detail');
    expect(c).toContain('run #7');
  });
});
