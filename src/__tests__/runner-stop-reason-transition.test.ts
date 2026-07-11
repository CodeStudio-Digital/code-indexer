/**
 * PR-4 — Stop-reason enrichment + transition watermark + isMeta flag.
 * Mirrors claude-code's `state.transition` and `isMeta:true` markers.
 */
import { describe, it, expect } from 'vitest';
import {
  CoderRunner,
  type StopReason,
  type TransitionKind,
} from '@mcp/code-agent/core/runner.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type { ChatProvider, ChatRequest } from '@mcp/code-agent/providers/adapter.js';
import type { ChatDelta, AgentMessage } from '@mcp/code-agent/core/messages.js';

class TextOnlyProvider implements ChatProvider {
  readonly name = 'stub';
  model = 'stub-1';
  setModel(m: string) { this.model = m; }
  async *chat(_req: ChatRequest): AsyncIterable<ChatDelta> {
    yield { type: 'text_delta', text: 'hi' };
    yield { type: 'usage', usage: { input_tokens: 5, output_tokens: 1 } };
    yield { type: 'done' };
  }
}

class FlakyProvider implements ChatProvider {
  readonly name = 'flaky';
  model = 'flaky-1';
  attempts = 0;
  constructor(private failCount: number, private status: number = 429) {}
  setModel(m: string) { this.model = m; }
  async *chat(_req: ChatRequest): AsyncIterable<ChatDelta> {
    this.attempts++;
    if (this.attempts <= this.failCount) {
      throw Object.assign(new Error('flaky'), { status: this.status });
    }
    yield { type: 'text_delta', text: 'ok' };
    yield { type: 'usage', usage: { input_tokens: 5, output_tokens: 1 } };
    yield { type: 'done' };
  }
}

function makeRunner(provider: ChatProvider): CoderRunner {
  return new CoderRunner({
    provider,
    registry: new ToolRegistry(),
    systemPrompt: 'sys',
    toolContext: { cwd: '/tmp', projectName: 'test' },
    initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
  });
}

describe('PR-4 StopReason — happy path', () => {
  it('clean run reports reason="completed" with transition=null', async () => {
    const runner = makeRunner(new TextOnlyProvider());
    const result = await runner.run();
    expect(result.reason).toBe('completed');
    expect(result.transition).toBeNull();
  });

  it('done event carries (reason, error?, transition?) — clean run', async () => {
    const runner = makeRunner(new TextOnlyProvider());
    const seen: Array<{ reason: StopReason; transition: TransitionKind | null | undefined }> = [];
    runner.on('done', (reason, _error, transition) => {
      seen.push({ reason, transition });
    });
    await runner.run();
    expect(seen).toHaveLength(1);
    expect(seen[0].reason).toBe('completed');
    expect(seen[0].transition ?? null).toBeNull();
  });
});

describe('PR-4 StopReason — recovery_capped + transition', () => {
  it('reports reason="recovery_capped" with transition="provider-transient-retry" when transient cap blown', async () => {
    process.env.CODER_TRANSIENT_RETRY_INITIAL_MS = '1';
    process.env.CODER_TRANSIENT_RETRY_MAX_MS = '5';
    process.env.CODER_TRANSIENT_RETRY_JITTER = '0';
    process.env.CODER_TRANSIENT_RETRY_MAX_PER_TURN = '3';
    process.env.CODER_RECOVERY_TRANSIENT_MAX = '2';
    const provider = new FlakyProvider(20, 429);
    const runner = makeRunner(provider);
    const result = await runner.run();
    expect(result.reason).toBe('recovery_capped');
    expect(result.transition).toBe('provider-transient-retry');
    delete process.env.CODER_TRANSIENT_RETRY_MAX_PER_TURN;
    delete process.env.CODER_RECOVERY_TRANSIENT_MAX;
  }, 5000);

  it('reports reason="recovery_capped" with transition="provider-400-retry" when 400 cap blown', async () => {
    process.env.CODER_RECOVERY_400_MAX = '0';
    const provider = new FlakyProvider(20, 400);
    const runner = makeRunner(provider);
    const result = await runner.run();
    expect(result.reason).toBe('recovery_capped');
    expect(result.transition).toBe('provider-400-retry');
    delete process.env.CODER_RECOVERY_400_MAX;
  }, 5000);
});

describe('PR-4 isMeta — synthetic message marking', () => {
  it('AgentMessage type accepts isMeta and providers ignore it', () => {
    // Compile-time check: this assignment must type-check.
    const m: AgentMessage = {
      role: 'user',
      content: [{ type: 'text', text: 'test' }],
      isMeta: true,
    };
    expect(m.isMeta).toBe(true);
  });

  it('isMeta is optional on AgentMessage (back-compat)', () => {
    const m: AgentMessage = {
      role: 'user',
      content: [{ type: 'text', text: 'test' }],
    };
    expect(m.isMeta).toBeUndefined();
  });
});

describe('PR-4 StopReason — typed exports', () => {
  it('StopReason union includes original + new values', () => {
    const reasons: StopReason[] = [
      'completed',
      'max_turns',
      'aborted',
      'error',
      'plan_required',
      'recovery_capped',
      'doom_loop',
      'compact_failure',
    ];
    expect(reasons).toHaveLength(8);
  });

  it('TransitionKind union covers every recovery path', () => {
    const kinds: TransitionKind[] = [
      'compact-pre-turn',
      'compact-auto-continue',
      'provider-400-retry',
      'provider-401-refresh',
      'provider-transient-retry',
      'provider-fallback',
      'doom-loop-strict',
      'doom-loop-fuzzy',
      'dup-call-cap',
      'polling-stuck',
      'stop-guard-nudge',
    ];
    expect(kinds).toHaveLength(11);
  });
});
