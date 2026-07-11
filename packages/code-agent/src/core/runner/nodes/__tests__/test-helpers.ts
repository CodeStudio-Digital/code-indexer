/**
 * Lightweight test helpers for BT node unit tests. Builds a `RunContext`
 * with mock provider/registry/toolContext so each test can focus on the
 * behaviour under test without re-deriving full wiring.
 *
 * NOT a public API — only `nodes/__tests__/*` consumes this.
 */
import type { RunContext } from '../../machine/types.js';
import type { RunnerEvents } from '../../events.js';
import type { ChatProvider } from '@mcp/code-agent/providers/adapter.js';
import type { CoderProfile, ToolTier } from '@mcp/code-agent/tools/tiers.js';
import type { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { AsyncOperationRegistry } from '../../operations.js';
import { NoProgressTracker } from '../../guards/no-progress.js';

export interface RecordedEvent<E extends keyof RunnerEvents = keyof RunnerEvents> {
  event: E;
  args: Parameters<RunnerEvents[E]>;
}

export interface TestContext {
  ctx: RunContext;
  recordedEvents: RecordedEvent[];
}

export interface MakeCtxOverrides {
  profile?: CoderProfile | null;
  planMode?: boolean;
  maxTurns?: number;
  tiers?: Set<ToolTier>;
  providerName?: string;
  providerModel?: string;
  /**
   * Inject a fully-formed provider — overrides the default mock that throws
   * on `chat()`. Use this when the node under test exercises the streaming
   * path (e.g. the LLM compactor).
   */
  provider?: ChatProvider;
  /** Inject a ToolRegistry — overrides the default no-op stub. */
  registry?: ToolRegistry;
  /** Inject a ToolContext — overrides the default empty stub. */
  toolContext?: ToolContext;
}

function makeMockProvider(name: string, model: string): ChatProvider {
  const provider: ChatProvider = {
    name,
    model,
    setModel(m: string) {
      provider.model = m;
    },
    chat: () => {
      throw new Error('mock provider — chat not invoked in this test');
    },
  };
  return provider;
}

export function makeTestContext(overrides: MakeCtxOverrides = {}): TestContext {
  const recordedEvents: RecordedEvent[] = [];
  const emit = ((event: keyof RunnerEvents, ...args: unknown[]) => {
    recordedEvents.push({ event, args: args as never });
  }) as RunContext['emit'];

  const ctx: RunContext = {
    opts: {
      provider: overrides.provider ?? makeMockProvider(
        overrides.providerName ?? 'mock',
        overrides.providerModel ?? 'mock-model',
      ),
      maxTurns: overrides.maxTurns ?? 50,
      planMode: overrides.planMode ?? false,
      profile: overrides.profile ?? null,
      registry: overrides.registry ?? ({} as never),
      systemPrompt: 'sys',
      toolContext: overrides.toolContext ?? ({} as never),
    } as never,
    emit,
    messages: [],
    turn: 0,
    totalUsage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    activeTiers: overrides.tiers ?? new Set<ToolTier>(['bootstrap']),
    pinnedTools: new Set<string>(),
    terseDescriptionsLock: null,
    recovery: new Map(),
    dupCalls: new Map(),
    noProgressTracker: new NoProgressTracker(),
    autoContinues: 0,
    preEmitCompactions: 0,
    consecutiveNoopCompactions: 0,
    planNudges: 0,
    goalVerifyAttempts: 0,
    estimateCalibration: null,
    runId: 'test-run',
    aborted: false,
    transition: null,
    stopReason: null,
    error: null,
    operations: new AsyncOperationRegistry(emit),
    lastTurnTelemetryId: null,
    // PR 5 — tests start with an empty failure-streak state. Tests that
    // need to exercise the guard seed entries directly via the helper.
    failureStreaks: { streaks: new Map() },
    // P0 — empty doom-loop + dominance windows. Tests that exercise the
    // per-turn backstops seed these directly.
    doomLoop: { strict: [], fuzzy: [] },
    dominance: { window: [] },
    // Fix B — loop-aware compaction signals start at zero.
    consecutiveNoTextTurns: 0,
    cumulativeInputTokens: 0,
    cumulativeAtLastCompaction: 0,
    // PR-F — every test context carries an empty injection state so
    // Executing's dynamic-injection helper doesn't NPE. Tests that
    // exercise injection seed this explicitly.
    injectionState: {
      lastInjectedSkillIds: new Set<string>(),
      executedSkillIds: new Set<string>(),
      lastInjectedFiles: new Set<string>(),
      recentCompactionAt: null,
      lastInjectedMemoryIds: new Set<string>(),
      lastInjectedConversationChapterIds: new Set<string>(),
      lastInjectedSessionStateHash: null,
      lastInjectedProjectIndexHash: null,
      lastInjectedConversationChapterIndexHash: null,
      lastInjectedUserMemoryHash: null,
      lastInjectedPreflightHash: null,
      // Fix A — self_review nudge gate state.
      selfReview: { suppressed: false },
      correctionNudge: { lastHash: null, count: 0 },
    },
  };
  return { ctx, recordedEvents };
}
