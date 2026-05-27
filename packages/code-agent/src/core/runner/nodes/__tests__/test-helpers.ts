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
      registry: {} as never,
      systemPrompt: 'sys',
      toolContext: {} as never,
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
    recovery: new Map(),
    dupCalls: new Map(),
    autoContinues: 0,
    runId: 'test-run',
    aborted: false,
    transition: null,
    stopReason: null,
    error: null,
  };
  return { ctx, recordedEvents };
}
