import { beforeEach, describe, expect, it } from 'vitest';
import {
  renderBugDescription,
  renderBugTitle,
  renderRecurrenceComment,
  syncFeatureCard,
  upsertBugCard,
  type KanbanBridgeDeps,
} from '@mcp/services/qa/kanban-bridge.js';
import type { QaRun, QaTestResult } from '@mcp/services/qa/types.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const RESULT_ID = '33333333-3333-4333-8333-333333333333';
const FEATURE_CARD_ID = '44444444-4444-4444-8444-444444444444';

function cardId(sequence: number): string {
  return `55555555-5555-4555-8555-${String(sequence).padStart(12, '0')}`;
}

interface FakeCard {
  id: string;
  title: string;
  description: string;
  column: string;
  tag: string | null;
  comments: Array<{ author: string; content: string }>;
}

class FakeCompanyStore {
  cards = new Map<string, FakeCard>();
  dependencies: Array<{ card_id: string; depends_on_id: string }> = [];
  private nextId = 100;

  createKanbanCard(_sessionId: string, input: {
    title: string;
    description?: string;
    column?: string;
    tag?: string | null;
  }): FakeCard {
    const card: FakeCard = {
      id: cardId(this.nextId++),
      title: input.title,
      description: input.description ?? '',
      column: input.column ?? 'backlog',
      tag: input.tag ?? null,
      comments: [],
    };
    this.cards.set(card.id, card);
    return card;
  }

  getKanbanCard(id: string): FakeCard | null {
    return this.cards.get(id) ?? null;
  }

  addKanbanComment(
    id: string,
    author: string,
    _agentRunId: string | null,
    content: string,
  ): void {
    this.cards.get(id)?.comments.push({ author, content });
  }

  addCardDependency(id: string, dependsOnId: string): void {
    this.dependencies.push({ card_id: id, depends_on_id: dependsOnId });
  }

  moveKanbanCard(id: string, column: string): FakeCard {
    const card = this.cards.get(id);
    if (!card) throw new Error(`card ${id} not found`);
    card.column = column;
    return card;
  }
}

class FakeQaResultStore {
  byTest = new Map<string, QaTestResult>();
  stamps = new Map<string, string | null>();

  async findRecentResultByName(opts: {
    spec_file: string;
    test_name: string;
  }): Promise<QaTestResult | null> {
    return this.byTest.get(`${opts.spec_file}::${opts.test_name}`) ?? null;
  }

  async setKanbanCardId(
    resultId: string,
    kanbanCardId: string | null,
  ): Promise<void> {
    this.stamps.set(resultId, kanbanCardId);
  }
}

function makeDeps(
  companyStore: FakeCompanyStore,
  qaResultStore: FakeQaResultStore,
): KanbanBridgeDeps {
  return {
    companyStore: companyStore as unknown as KanbanBridgeDeps['companyStore'],
    qaResultStore,
  };
}

function makeRun(over: Partial<QaRun> = {}): QaRun {
  return {
    id: RUN_ID,
    seq: 1,
    company_session_id: SESSION_ID,
    agent_run_id: null,
    suite: 'login',
    service_id: 'main',
    status: 'completed',
    started_at: '2026-04-25T10:00:00.000Z',
    completed_at: '2026-04-25T10:01:00.000Z',
    passed: 0,
    failed: 1,
    skipped: 0,
    duration_ms: 60_000,
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
    id: RESULT_ID,
    seq: 1,
    run_id: RUN_ID,
    spec_file: 'tests/e2e/login.spec.ts',
    test_name: 'wrong password keeps the form',
    status: 'failed',
    duration_ms: 1_500,
    error: 'Expected text not visible',
    trace_path: 'test-results/login/trace.zip',
    screenshot_path: 'test-results/login/screenshot.png',
    video_path: 'test-results/login/video.webm',
    summary_md_path: 'test-results/login/summary.md',
    kanban_card_id: null,
    created_at: '2026-04-25T10:00:30.000Z',
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

  it('creates a new bug card on first failure and stamps the result', async () => {
    const run = makeRun();
    const result = makeResult();
    const out = await upsertBugCard(makeDeps(companyStore, qaResultStore), {
      sessionId: SESSION_ID,
      run,
      result,
      buildEvidenceUrl: (path) => `/api/sessions/${SESSION_ID}/qa/artifact?path=${path}`,
      runDetailUrl: `/c/${SESSION_ID}?tab=tests&run=${RUN_ID}`,
    });

    expect(out).toMatchObject({ created: true, cardId: expect.any(String) });
    const card = companyStore.cards.get(out.cardId!);
    expect(card).toMatchObject({
      tag: 'bug',
      column: 'todo',
      title: '[QA-BUG] login: wrong password keeps the form',
    });
    expect(card?.description).toContain('Expected text not visible');
    expect(card?.description).toContain('test-results/login/video.webm');
    expect(qaResultStore.stamps.get(RESULT_ID)).toBe(out.cardId);
  });

  it('reuses the existing card when the same test fails again', async () => {
    const run = makeRun();
    const firstResult = makeResult();
    const first = await upsertBugCard(makeDeps(companyStore, qaResultStore), {
      sessionId: SESSION_ID,
      run,
      result: firstResult,
      buildEvidenceUrl: (path) => path,
    });
    qaResultStore.byTest.set(
      `${firstResult.spec_file}::${firstResult.test_name}`,
      { ...firstResult, kanban_card_id: first.cardId },
    );
    const secondResult = makeResult({
      id: '66666666-6666-4666-8666-666666666666',
      error: 'Different message',
    });

    const second = await upsertBugCard(makeDeps(companyStore, qaResultStore), {
      sessionId: SESSION_ID,
      run,
      result: secondResult,
      buildEvidenceUrl: (path) => path,
    });

    expect(second).toMatchObject({ created: false, cardId: first.cardId });
    expect(companyStore.cards.get(first.cardId!)?.comments[0]?.content)
      .toContain(`Failure recurred in run #${RUN_ID}`);
    expect(qaResultStore.stamps.get(secondResult.id)).toBe(first.cardId);
  });

  it('links the bug card to the feature card via UUID dependency', async () => {
    const out = await upsertBugCard(makeDeps(companyStore, qaResultStore), {
      sessionId: SESSION_ID,
      run: makeRun({ kanban_feature_card_id: FEATURE_CARD_ID }),
      result: makeResult(),
      buildEvidenceUrl: (path) => path,
    });
    expect(companyStore.dependencies).toContainEqual({
      card_id: out.cardId,
      depends_on_id: FEATURE_CARD_ID,
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

  function seedFeature(column: string): void {
    companyStore.cards.set(FEATURE_CARD_ID, {
      id: FEATURE_CARD_ID,
      title: 'QA: login',
      description: '',
      column,
      tag: null,
      comments: [],
    });
  }

  it('moves a card to done when all green', async () => {
    seedFeature('in_progress');
    const out = await syncFeatureCard(makeDeps(companyStore, qaResultStore), {
      featureCardId: FEATURE_CARD_ID,
      run: makeRun({ passed: 3, failed: 0 }),
      passed: 3,
      failed: 0,
      runDetailUrl: `/c/${SESSION_ID}`,
    });
    expect(out.column).toBe('done');
    expect(companyStore.cards.get(FEATURE_CARD_ID)?.comments[0]?.content)
      .toContain('QA verde');
  });

  it('moves a done card back to in_progress when red', async () => {
    seedFeature('done');
    const out = await syncFeatureCard(makeDeps(companyStore, qaResultStore), {
      featureCardId: FEATURE_CARD_ID,
      run: makeRun({ passed: 2, failed: 1 }),
      passed: 2,
      failed: 1,
    });
    expect(out.column).toBe('in_progress');
    expect(companyStore.cards.get(FEATURE_CARD_ID)?.comments[0]?.content)
      .toContain('QA red');
  });

  it('does not move a missing card and reports a warning', async () => {
    const out = await syncFeatureCard(makeDeps(companyStore, qaResultStore), {
      featureCardId: FEATURE_CARD_ID,
      run: makeRun(),
      passed: 0,
      failed: 1,
    });
    expect(out.column).toBeNull();
    expect(out.warnings.some((warning) => warning.includes('missing'))).toBe(true);
  });
});

describe('renderers', () => {
  it('renders title, evidence, UUID run reference, and recurrence safely', () => {
    const run = makeRun({ suite: 'auth/forgot-password' });
    const result = makeResult({
      test_name: 'sends email when address is valid',
      error: 'first line\nignored detail',
    });
    const opts = {
      sessionId: SESSION_ID,
      run,
      result,
      buildEvidenceUrl: (path: string) => `/x/${path}`,
      runDetailUrl: `/c/${SESSION_ID}?run=${RUN_ID}`,
    };

    expect(renderBugTitle(opts))
      .toBe('[QA-BUG] auth/forgot-password: sends email when address is valid');
    const description = renderBugDescription(opts);
    expect(description).toContain('/x/test-results/login/video.webm');
    expect(description).toContain('/x/test-results/login/screenshot.png');
    expect(description).toContain(`/c/${SESSION_ID}?run=${RUN_ID}`);
    expect(description).toContain(`run #${RUN_ID}`);
    const recurrence = renderRecurrenceComment(opts);
    expect(recurrence).toContain('first line');
    expect(recurrence).not.toContain('ignored detail');
    expect(recurrence).toContain(`run #${RUN_ID}`);
  });
});
