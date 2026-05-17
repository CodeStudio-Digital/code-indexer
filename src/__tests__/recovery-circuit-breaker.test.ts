/**
 * PR-2 (R1 + R5) — recovery circuit breaker and exp+jitter retry path.
 *
 * Drives a real CoderRunner with a controllable mock provider that throws
 * status=429 / 5xx for a configurable number of attempts, then succeeds.
 * Verifies:
 *   - Transient errors retry up to TRANSIENT_RETRY_MAX_PER_TURN within a
 *     single turn before falling through (R5).
 *   - The session-wide circuit breaker emits `recovery_aborted` when the
 *     per-kind cap is exceeded (R1).
 */
import { describe, it, expect } from 'vitest';
import { CoderRunner } from '@mcp/code-agent/core/runner.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type { ChatProvider, ChatRequest } from '@mcp/code-agent/providers/adapter.js';
import type { ChatDelta } from '@mcp/code-agent/core/messages.js';

/**
 * Throws a `status: 429` (or any configurable status) for the first N calls
 * to chat(), then yields a normal text-only completion.
 */
class FlakyProvider implements ChatProvider {
  readonly name = 'flaky';
  model = 'flaky-1';
  attempts = 0;
  constructor(
    private failCount: number,
    private status: number = 429,
    private message: string = 'rate limited',
  ) {}
  setModel(m: string) { this.model = m; }
  async *chat(_req: ChatRequest): AsyncIterable<ChatDelta> {
    this.attempts++;
    if (this.attempts <= this.failCount) {
      const err = Object.assign(new Error(this.message), { status: this.status });
      throw err;
    }
    yield { type: 'text_delta', text: 'recovered' };
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

describe('PR-2 R5 — transient retry with exp+jitter (no fallback chain)', () => {
  it('recovers within the same turn after 2 transient 429s', async () => {
    process.env.CODER_TRANSIENT_RETRY_INITIAL_MS = '1';
    process.env.CODER_TRANSIENT_RETRY_MAX_MS = '5';
    process.env.CODER_TRANSIENT_RETRY_JITTER = '0';
    const provider = new FlakyProvider(2, 429);
    const runner = makeRunner(provider);
    const result = await runner.run();
    expect(result.reason).toBe('completed');
    expect(provider.attempts).toBe(3); // 2 failures + 1 success
  }, 5000);

  it('recovers from 5xx the same way as 429', async () => {
    process.env.CODER_TRANSIENT_RETRY_INITIAL_MS = '1';
    process.env.CODER_TRANSIENT_RETRY_MAX_MS = '5';
    process.env.CODER_TRANSIENT_RETRY_JITTER = '0';
    const provider = new FlakyProvider(2, 503);
    const runner = makeRunner(provider);
    const result = await runner.run();
    expect(result.reason).toBe('completed');
    expect(provider.attempts).toBe(3);
  }, 5000);

  it('falls through to error when retries exhausted with no fallback configured', async () => {
    process.env.CODER_TRANSIENT_RETRY_INITIAL_MS = '1';
    process.env.CODER_TRANSIENT_RETRY_MAX_MS = '5';
    process.env.CODER_TRANSIENT_RETRY_JITTER = '0';
    process.env.CODER_TRANSIENT_RETRY_MAX_PER_TURN = '3';
    // 4 failures > 3 retries per turn AND no fallback chain → reason='error'.
    const provider = new FlakyProvider(4, 429);
    const runner = makeRunner(provider);
    const result = await runner.run();
    expect(result.reason).toBe('error');
    // 1 initial + 3 retries = 4 attempts.
    expect(provider.attempts).toBe(4);
    delete process.env.CODER_TRANSIENT_RETRY_MAX_PER_TURN;
  }, 5000);

  it('does not retry permanent Claude Code extra-usage exhaustion', async () => {
    const provider = new FlakyProvider(
      10,
      400,
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"You\'re out of extra usage. Add more at claude.ai/settings/usage and keep going."}}',
    );
    const runner = makeRunner(provider);
    const result = await runner.run();

    expect(result.reason).toBe('error');
    expect(result.transition).toBeNull();
    expect(provider.attempts).toBe(1);
  });
});

describe('PR-2 R1 — session-wide circuit breaker', () => {
  it('emits recovery_aborted when transient retries exceed session cap', async () => {
    process.env.CODER_TRANSIENT_RETRY_INITIAL_MS = '1';
    process.env.CODER_TRANSIENT_RETRY_MAX_MS = '5';
    process.env.CODER_TRANSIENT_RETRY_JITTER = '0';
    process.env.CODER_TRANSIENT_RETRY_MAX_PER_TURN = '3';
    process.env.CODER_RECOVERY_TRANSIENT_MAX = '2';
    const provider = new FlakyProvider(10, 429);
    const runner = makeRunner(provider);
    const aborts: Array<{ kind: string; attempts: number; cap: number }> = [];
    runner.on('recovery_aborted', (p) => aborts.push({ kind: p.kind, attempts: p.attempts, cap: p.cap }));
    const result = await runner.run();
    expect(result.reason).toBe('recovery_capped');
    expect(aborts.length).toBeGreaterThanOrEqual(1);
    expect(aborts[0].kind).toBe('provider-transient-retry');
    expect(aborts[0].cap).toBe(2);
    expect(aborts[0].attempts).toBeGreaterThan(2);
    delete process.env.CODER_TRANSIENT_RETRY_MAX_PER_TURN;
    delete process.env.CODER_RECOVERY_TRANSIENT_MAX;
  }, 5000);

  it('emits recovery_aborted with kind=provider-400-retry when 400 cap is zero', async () => {
    // cap=0 means "no 400 retries allowed at all" → first 400 trips the
    // circuit breaker. The realistic cap (default 3) only fires across
    // multi-turn sessions with recurring 400s; in a single-turn unit test
    // we set it to 0 to exercise the abort branch deterministically.
    process.env.CODER_RECOVERY_400_MAX = '0';
    const provider = new FlakyProvider(10, 400, 'illegal message sequence');
    const runner = makeRunner(provider);
    const aborts: Array<{ kind: string; attempts: number; cap: number }> = [];
    runner.on('recovery_aborted', (p) => aborts.push({ kind: p.kind, attempts: p.attempts, cap: p.cap }));
    const result = await runner.run();
    // PR-4: cap-blown abort surfaces as the more-specific 'recovery_capped'
    // (was 'error' before). Existing consumers branching only on 'completed'
    // are unaffected.
    expect(result.reason).toBe('recovery_capped');
    const abort = aborts.find((a) => a.kind === 'provider-400-retry');
    expect(abort).toBeDefined();
    expect(abort!.cap).toBe(0);
    delete process.env.CODER_RECOVERY_400_MAX;
  }, 5000);

  it('emits recovery_aborted with kind=provider-401-refresh when 401 cap is zero', async () => {
    process.env.CODER_RECOVERY_401_MAX = '0';
    const provider = new FlakyProvider(10, 401, 'token expired');
    const runner = new CoderRunner({
      provider,
      registry: new ToolRegistry(),
      systemPrompt: 'sys',
      toolContext: { cwd: '/tmp', projectName: 'test' },
      initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      // 401 path needs createProvider to even attempt the refresh.
      createProvider: async (name, model) => {
        const p = new FlakyProvider(10, 401, 'token expired');
        p.model = model;
        Object.defineProperty(p, 'name', { value: name });
        return p;
      },
    });
    const aborts: Array<{ kind: string }> = [];
    runner.on('recovery_aborted', (p) => aborts.push({ kind: p.kind }));
    const result = await runner.run();
    expect(result.reason).toBe('recovery_capped');
    expect(aborts.find((a) => a.kind === 'provider-401-refresh')).toBeDefined();
    delete process.env.CODER_RECOVERY_401_MAX;
  }, 5000);
});
