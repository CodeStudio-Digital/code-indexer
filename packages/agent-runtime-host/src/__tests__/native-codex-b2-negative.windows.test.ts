import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import {
  agentV1Runtime,
  agentV1SessionStore,
} from '@mcp/agent-runtime-contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  NativeRustHostAttemptRuntime,
} from '../native/NativeRustHostAttemptRuntime.js';
import {
  processRealFixture,
  readProcessRealEngineEvents,
  B2_MUTATION_PROBE_TOKEN,
  type ProcessRealCodexFixtureScenario,
  type ProcessRealCodexOptions,
  type ProcessRealFixture,
} from './native-process-real-active-support.js';

const binary = process.env.MCP_CODEX_B2_FIXTURE_BINARY;
const enabled = process.platform === 'win32'
  && process.env.MCP_RUST_AGENT_PROCESS_REAL_E2E === '1'
  && typeof binary === 'string'
  && isAbsolute(binary)
  && existsSync(binary);
const physicalIt = enabled ? it : it.skip;
const mutationPhysicalIt = enabled
  && process.env.MCP_CODEX_B2_MUTATION_FIXTURE === '1' ? it : it.skip;
const FIXTURE_VERSION = 'b2-fixture-v1';
const FIXTURE_SCHEMA_DIGEST = createHash('sha256')
  .update('codestudio.codex-b2-adversarial-fixture.v1')
  .digest('hex');

describe('physical Codex B2 negative matrix', () => {
  physicalIt.each(['unknown-tool', 'builtin-bypass'] as const)(
    'fails closed and commits a terminal record for %s',
    async (scenario) => {
      const fixture = await negativeFixture(scenario);
      const runtime = await NativeRustHostAttemptRuntime.create(fixture.options);
      try {
        const result = await runtime.run(fixture.prepare);
        expect(result.kind).toBe('active');
        if (result.kind !== 'active') throw new Error(`${scenario} launch rejected`);
        const records = await waitForRecords(fixture, (items) =>
          items.some(({ body }) => body.case === 'terminal'));
        const terminal = records.find(({ body }) => body.case === 'terminal')!;
        expect(terminal.body.value).toMatchObject({
          classification: agentV1SessionStore.EngineTerminalClassificationV1.FAILED,
          reasonCode: 'provider_failed',
        });
        expect(fixture.observed.capabilityPrepareCount).toBe(0);
        await cancelAndReap(runtime, result.authority, scenario);
        expect(fixture.committedFacts.slice(-2)).toEqual([
          'attemptProcessExited',
          'attemptProcessReaped',
        ]);
      } finally {
        await runtime.close().catch(() => undefined);
        await rm(fixture.sessionRoot!, { recursive: true, force: true });
      }
    },
    60_000,
  );

  physicalIt('bounds cumulative provider output and terminalizes the turn', async () => {
    const fixture = await negativeFixture('large-provider-output');
    const runtime = await NativeRustHostAttemptRuntime.create(fixture.options);
    try {
      const result = await runtime.run(fixture.prepare);
      expect(result.kind).toBe('active');
      if (result.kind !== 'active') throw new Error('large output launch rejected');
      const records = await waitForRecords(fixture, (items) =>
        items.some(({ body }) => body.case === 'terminal'));
      const terminal = records.find(({ body }) => body.case === 'terminal')!;
      expect(terminal.body.value).toMatchObject({
        classification: agentV1SessionStore.EngineTerminalClassificationV1.INTERRUPTED,
        reasonCode: 'response_bytes_exceeded',
      });
      expect(records.filter(({ body }) => body.case === 'providerDelta'))
        .toHaveLength(9);
      expect(fixture.observed.capabilityPrepareCount).toBe(0);
      await cancelAndReap(runtime, result.authority, 'large-provider-output');
    } finally {
      await runtime.close().catch(() => undefined);
      await rm(fixture.sessionRoot!, { recursive: true, force: true });
    }
  }, 60_000);

  physicalIt('returns a bounded tool failure and never retries the capability', async () => {
    const fixture = await negativeFixture('tool-output-limit', {
      sampleContent: 'x'.repeat(4 * 1_024),
      maxReadBytes: 4n * 1_024n,
      maxOutputBytes: 1_024n,
    });
    const runtime = await NativeRustHostAttemptRuntime.create(fixture.options);
    try {
      const result = await runtime.run(fixture.prepare);
      expect(result.kind).toBe('active');
      if (result.kind !== 'active') throw new Error('tool output limit launch rejected');
      const records = await waitForRecords(fixture, (items) =>
        items.some(({ body }) => body.case === 'terminal'));
      const capability = records.find(({ body }) => body.case === 'capabilityTerminal')!;
      expect(capability.body.value).toMatchObject({
        classification:
          agentV1SessionStore.EngineCapabilityTerminalClassificationV1.FAILED,
        reasonCode: 'read_limit_exceeded',
      });
      const terminal = records.find(({ body }) => body.case === 'terminal')!;
      expect(terminal.body.value).toMatchObject({
        classification: agentV1SessionStore.EngineTerminalClassificationV1.COMPLETED,
        reasonCode: 'completed',
      });
      expect(fixture.observed.capabilityPrepareCount).toBe(1);
      await expect(runtime.inspectUnresolvedCapabilityDispatches(64))
        .resolves.toEqual([]);
      await cancelAndReap(runtime, result.authority, 'tool-output-limit');
    } finally {
      await runtime.close().catch(() => undefined);
      await rm(fixture.sessionRoot!, { recursive: true, force: true });
    }
  }, 60_000);

  physicalIt('cancels and reaps a child stalled during initialize', async () => {
    const fixture = await negativeFixture('hang-initialize');
    const runtime = await NativeRustHostAttemptRuntime.create(fixture.options);
    try {
      const result = await runtime.run(fixture.prepare);
      expect(result.kind).toBe('active');
      if (result.kind !== 'active') throw new Error('hang initialize launch rejected');
      await vi.waitFor(() => {
        expect(runtime.inspectActive(result.authority).heartbeat?.resources.processCount ?? 0)
          .toBeGreaterThanOrEqual(2);
      }, { timeout: 10_000, interval: 50 });
      const startedAt = performance.now();
      await cancelAndReap(runtime, result.authority, 'hang-initialize');
      expect(performance.now() - startedAt).toBeLessThan(5_000);
      expect(fixture.observed.capabilityPrepareCount).toBe(0);
    } finally {
      await runtime.close().catch(() => undefined);
      await rm(fixture.sessionRoot!, { recursive: true, force: true });
    }
  }, 60_000);

  physicalIt('reaps a stalled child at the immutable authority deadline', async () => {
    const fixture = await negativeFixture('hang-initialize', {
      hardDeadlineMs: 20_000n,
      specDeadlineMs: 12_000n,
    });
    const runtime = await NativeRustHostAttemptRuntime.create(fixture.options);
    try {
      const result = await runtime.run(fixture.prepare);
      expect(result.kind).toBe('active');
      if (result.kind !== 'active') throw new Error('deadline launch rejected');
      const startedAt = performance.now();
      await withTimeout(runtime.waitForPhysicalReap(), 22_000);
      const elapsed = performance.now() - startedAt;
      expect(elapsed).toBeGreaterThan(8_000);
      expect(elapsed).toBeLessThan(22_000);
      expect(runtime.isFailed).toBe(true);
      expect(fixture.committedFacts.slice(-2)).toEqual([
        'attemptProcessExited',
        'attemptProcessReaped',
      ]);
    } finally {
      await runtime.close().catch(() => undefined);
      await rm(fixture.sessionRoot!, { recursive: true, force: true });
    }
  }, 60_000);

  physicalIt('reaps automatically when the engine exits on protocol corruption', async () => {
    const fixture = await negativeFixture('correlation-mismatch');
    const runtime = await NativeRustHostAttemptRuntime.create(fixture.options);
    try {
      const result = await runtime.run(fixture.prepare);
      expect(result.kind).toBe('active');
      if (result.kind !== 'active') throw new Error('correlation launch rejected');
      await withTimeout(runtime.waitForPhysicalReap(), 10_000);
      expect(fixture.committedFacts.slice(-2)).toEqual([
        'attemptProcessExited',
        'attemptProcessReaped',
      ]);
      expect(fixture.observed.capabilityPrepareCount).toBe(0);
      const records = await readProcessRealEngineEvents(fixture);
      expect(records.some(({ body }) => body.case === 'providerStarted')).toBe(true);
      expect(records.some(({ body }) => body.case === 'terminal')).toBe(false);
    } finally {
      await runtime.close().catch(() => undefined);
      await rm(fixture.sessionRoot!, { recursive: true, force: true });
    }
  }, 60_000);

  physicalIt('does not retry after the peer drops the post-tool-result transport', async () => {
    const fixture = await negativeFixture('ack-lost-after-tool');
    const runtime = await NativeRustHostAttemptRuntime.create(fixture.options);
    try {
      const result = await runtime.run(fixture.prepare);
      expect(result.kind).toBe('active');
      if (result.kind !== 'active') throw new Error('ACK-loss launch rejected');
      const records = await waitForRecords(fixture, (items) =>
        items.some(({ body }) => body.case === 'capabilityTerminal'));
      await withTimeout(runtime.waitForPhysicalReap(), 10_000);
      const starts = records.filter(({ body }) =>
        body.case === 'capabilityDispatchStarted');
      const terminals = records.filter(({ body }) =>
        body.case === 'capabilityTerminal');
      expect(starts).toHaveLength(1);
      expect(terminals).toHaveLength(1);
      expect(terminals[0]!.body.value).toMatchObject({
        classification:
          agentV1SessionStore.EngineCapabilityTerminalClassificationV1.SUCCEEDED,
        reasonCode: 'succeeded',
      });
      expect(records.some(({ body }) => body.case === 'terminal')).toBe(false);
      expect(fixture.observed.capabilityPrepareCount).toBe(1);
      await expect(runtime.inspectUnresolvedCapabilityDispatches(64))
        .resolves.toEqual([]);
      expect(fixture.committedFacts.slice(-2)).toEqual([
        'attemptProcessExited',
        'attemptProcessReaped',
      ]);
    } finally {
      await runtime.close().catch(() => undefined);
      await rm(fixture.sessionRoot!, { recursive: true, force: true });
    }
  }, 60_000);

  mutationPhysicalIt('commits outcome_unknown and never retries a mutation after result loss', async () => {
    const fixture = await negativeFixture('mutating-ack-loss');
    const runtime = await NativeRustHostAttemptRuntime.create(fixture.options);
    try {
      const result = await runtime.run(fixture.prepare);
      expect(result.kind).toBe('active');
      if (result.kind !== 'active') throw new Error('mutating ACK-loss launch rejected');
      const records = await waitForRecords(fixture, (items) => items.some(({ body }) =>
        body.case === 'capabilityTerminal'
        && body.value.classification
          === agentV1SessionStore.EngineCapabilityTerminalClassificationV1.OUTCOME_UNKNOWN));
      const starts = records.filter(({ body }) => body.case === 'capabilityDispatchStarted');
      const terminals = records.filter(({ body }) => body.case === 'capabilityTerminal');
      expect(starts).toHaveLength(1);
      expect(terminals).toHaveLength(1);
      expect(terminals[0]!.body.value).toMatchObject({
        classification:
          agentV1SessionStore.EngineCapabilityTerminalClassificationV1.OUTCOME_UNKNOWN,
        reasonCode: 'host_executor_result_ambiguous',
      });
      expect(await readFile(fixture.expectedMutationTarget!, 'utf8'))
        .toBe(`${B2_MUTATION_PROBE_TOKEN}\n`);
      expect(fixture.observed.capabilityPrepareCount).toBe(1);
      await expect(runtime.inspectUnresolvedCapabilityDispatches(64))
        .resolves.toEqual([]);
      await cancelAndReap(runtime, result.authority, 'mutating-ack-loss');
    } finally {
      await runtime.close().catch(() => undefined);
      await rm(fixture.sessionRoot!, { recursive: true, force: true });
    }
  }, 60_000);
});

async function negativeFixture(
  scenario: ProcessRealCodexFixtureScenario,
  overrides: Partial<ProcessRealCodexOptions> = {},
): Promise<ProcessRealFixture> {
  return processRealFixture(false, true, {
    binary: binary!,
    candidateVersion: FIXTURE_VERSION,
    protocolSchemaDigest: FIXTURE_SCHEMA_DIGEST,
    scenario,
    ...overrides,
  });
}

async function waitForRecords(
  fixture: ProcessRealFixture,
  predicate: (records: readonly agentV1SessionStore.EngineEventRecordV1[]) => boolean,
): Promise<agentV1SessionStore.EngineEventRecordV1[]> {
  let records: agentV1SessionStore.EngineEventRecordV1[] = [];
  await vi.waitFor(async () => {
    records = await readProcessRealEngineEvents(fixture);
    expect(predicate(records)).toBe(true);
  }, { timeout: 15_000, interval: 50 });
  return records;
}

async function cancelAndReap(
  runtime: NativeRustHostAttemptRuntime,
  authority: Parameters<NativeRustHostAttemptRuntime['cancelActive']>[0],
  scenario: string,
): Promise<void> {
  await runtime.cancelActive(authority, {
    reason: agentV1Runtime.CancelReason.USER_REQUEST,
    reasonCode: `codex_b2_negative_${scenario.replaceAll('-', '_')}`,
    graceDeadlineAtUnixMs: BigInt(Date.now() + 750),
    idempotencyKey: `codex-b2-negative:${scenario}`,
  });
  await withTimeout(runtime.waitForPhysicalReap(), 10_000);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('physical reap timed out')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
