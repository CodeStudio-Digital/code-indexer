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
import { describe, it, expect, vi } from 'vitest';
import { resolveRuntimePolicyV1 } from '@mcp/agent-runtime-host';

vi.mock('@mcp/code-agent/core/runner/provider-retry.js', async (load) => ({
  ...(await load<typeof import('@mcp/code-agent/core/runner/provider-retry.js')>()),
  backoffDelayMs: () => 0,
}));
import { CoderRunner } from '@mcp/code-agent/core/runner.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type { ChatProvider, ChatRequest } from '@mcp/code-agent/providers/adapter.js';
import type { ChatDelta } from "@mcp/provider-sdk";

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

function makeRunner(provider: ChatProvider, runRetryCap = 30): CoderRunner {
  return new CoderRunner({
    provider,
    runtimePolicy: resolveRuntimePolicyV1({ request: { revision: 'test', values: { provider: { transientRetriesPerRun: runRetryCap } } } }),
    registry: new ToolRegistry(),
    systemPrompt: 'sys',
    toolContext: { cwd: '/tmp', projectName: 'test' },
    initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
  });
}

describe('PR-2 R5 — transient retry with exp+jitter (no fallback chain)', () => {
  it('recovers within the same turn after 2 transient 429s', async () => {

    const provider = new FlakyProvider(2, 429);
    const runner = makeRunner(provider);
    const result = await runner.run();
    expect(result.reason).toBe('completed');
    expect(provider.attempts).toBe(3); // 2 failures + 1 success
  }, 5000);

  it('recovers from 5xx the same way as 429', async () => {

    const provider = new FlakyProvider(2, 503);
    const runner = makeRunner(provider);
    const result = await runner.run();
    expect(result.reason).toBe('completed');
    expect(provider.attempts).toBe(3);
  }, 5000);

  it('stops at the per-turn retry cap with no fallback configured', async () => {

    // The fourth failure exceeds the fixed three-retry turn budget.
    const provider = new FlakyProvider(4, 429);
    const runner = makeRunner(provider);
    const result = await runner.run();
    expect(result.reason).toBe('recovery_capped');
    // 1 initial + 3 retries = 4 attempts.
    expect(provider.attempts).toBe(4);
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
    expect(result.transition).toBe('provider-400-retry');
    expect(provider.attempts).toBe(1);
  });
});

describe('PR-2 R1 — session-wide circuit breaker', () => {
  it('emits recovery_aborted when transient retries exceed session cap', async () => {

    const provider = new FlakyProvider(10, 429);
    const runner = makeRunner(provider, 2);
    const aborts: Array<{ kind: string; attempts: number; cap: number }> = [];
    runner.on('recovery_aborted', (p) => aborts.push({ kind: p.kind, attempts: p.attempts, cap: p.cap }));
    const result = await runner.run();
    expect(result.reason).toBe('recovery_capped');
    expect(aborts.length).toBeGreaterThanOrEqual(1);
    expect(aborts[0].kind).toBe('provider-transient-retry');
    expect(aborts[0].cap).toBe(2);
    expect(aborts[0].attempts).toBeGreaterThan(2);

  }, 5000);

  it('does not retry a non-retryable 400 or report a cap failure', async () => {
    const provider = new FlakyProvider(10, 400, 'illegal message sequence');
    const runner = makeRunner(provider);
    const aborts = vi.fn();
    runner.on('recovery_aborted', aborts);
    const result = await runner.run();
    expect(result.reason).toBe('error');
    expect(result.transition).toBe('provider-400-retry');
    expect(provider.attempts).toBe(1);
    expect(aborts).not.toHaveBeenCalled();
  });

  it('emits recovery_aborted when the fixed 401 refresh cap is exceeded', async () => {
    process.env.CODER_RECOVERY_401_MAX = '0';
    const provider = new FlakyProvider(10, 401, 'token expired');
    const runner = new CoderRunner({
      provider,
      registry: new ToolRegistry(),
      systemPrompt: 'sys',
      toolContext: { cwd: '/tmp', projectName: 'test' },
      initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    });
    const aborts: Array<{ kind: string; cap: number; attempts: number }> = [];
    runner.on('recovery_aborted', (p) => aborts.push({ kind: p.kind, cap: p.cap, attempts: p.attempts }));
    const result = await runner.run();
    expect(result.reason).toBe('recovery_capped');
    expect(aborts.find((a) => a.kind === 'provider-401-refresh')).toMatchObject({ cap: 2, attempts: 3 });
    delete process.env.CODER_RECOVERY_401_MAX;
  }, 5000);
});
