import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import {
  agentV1Common,
  agentV1Runtime,
  agentV1SessionStore,
} from '@mcp/agent-runtime-contracts';
import { describe, expect, it, vi } from 'vitest';
import { NativeRustHostAttemptRuntime } from '../native/NativeRustHostAttemptRuntime.js';
import {
  processRealFixture,
  readProcessRealEngineEvents,
  type ProcessRealCodexOptions,
  type ProcessRealFixture,
} from './native-process-real-active-support.js';

const FIXTURE_ITERATIONS = 100;
const REAL_CODEX_ITERATIONS = 5;
const MEMORY_LIMIT_BYTES = 512n * 1024n * 1024n;
const fixtureBinary = process.env.MCP_CODEX_B2_FIXTURE_BINARY;
const fixtureEnabled = process.platform === 'win32'
  && process.env.MCP_RUST_AGENT_PROCESS_REAL_E2E === '1'
  && process.env.MCP_CODEX_B2_SOAK === '1'
  && validBinary(fixtureBinary);
const realCodexEnabled = fixtureEnabled
  && validBinary(process.env.MCP_CODEX_B2_BINARY)
  && typeof process.env.MCP_CODEX_B2_VERSION === 'string'
  && /^[a-f0-9]{64}$/.test(process.env.MCP_CODEX_B2_SCHEMA_DIGEST ?? '');

describe('physical Codex B2 bounded soak', () => {
  (fixtureEnabled ? it : it.skip)(
    `repeats ${FIXTURE_ITERATIONS} supervised read turns without leak or retry`,
    async () => {
      const metrics = [];
      for (let iteration = 1; iteration <= FIXTURE_ITERATIONS; iteration += 1) {
        metrics.push(await runIteration({
          binary: fixtureBinary!,
          candidateVersion: 'b2-fixture-v1',
          protocolSchemaDigest: createHash('sha256')
            .update('codestudio.codex-b2-adversarial-fixture.v1')
            .digest('hex'),
          scenario: 'read-success',
        }, iteration));
      }
      assertSoak(metrics, FIXTURE_ITERATIONS, 0);
      emit('CODEX_B2_FIXTURE_SOAK_EVIDENCE', metrics);
    },
    10 * 60_000,
  );

  (realCodexEnabled ? it : it.skip)(
    `repeats ${REAL_CODEX_ITERATIONS} real Codex read turns within the same grants`,
    async () => {
      const metrics = [];
      for (let iteration = 1; iteration <= REAL_CODEX_ITERATIONS; iteration += 1) {
        metrics.push(await runIteration({
          binary: process.env.MCP_CODEX_B2_BINARY!,
          candidateVersion: process.env.MCP_CODEX_B2_VERSION!,
          protocolSchemaDigest: process.env.MCP_CODEX_B2_SCHEMA_DIGEST!,
        }, iteration));
      }
      assertSoak(metrics, REAL_CODEX_ITERATIONS, 2);
      emit('CODEX_B2_REAL_SOAK_EVIDENCE', metrics);
    },
    15 * 60_000,
  );
});

interface IterationMetric {
  readonly iteration: number;
  readonly elapsedMs: number;
  readonly peakResidentMemoryBytes: bigint;
  readonly maximumProcessCount: number;
  readonly journalRecords: number;
}

async function runIteration(
  codex: ProcessRealCodexOptions,
  iteration: number,
): Promise<IterationMetric> {
  const fixture = await processRealFixture(false, true, codex);
  const runtime = await NativeRustHostAttemptRuntime.create(fixture.options);
  const started = performance.now();
  let maximumProcessCount = 0;
  let closed = false;
  try {
    const result = await runtime.run(fixture.prepare);
    expect(result.kind).toBe('active');
    if (result.kind !== 'active') throw new Error(`soak iteration ${iteration} rejected`);
    const records = await waitForTerminal(fixture, () => {
      maximumProcessCount = Math.max(
        maximumProcessCount,
        runtime.inspectActive(result.authority).heartbeat?.resources.processCount ?? 0,
      );
    }, codex.scenario ? 15_000 : 120_000);
    const terminal = records.find(({ body }) => body.case === 'terminal');
    expect(terminal?.body.value).toMatchObject({
      classification: agentV1SessionStore.EngineTerminalClassificationV1.COMPLETED,
      reasonCode: 'completed',
    });
    expect(records.filter(({ body }) => body.case === 'capabilityDispatchStarted'))
      .toHaveLength(1);
    expect(records.filter(({ body }) => body.case === 'capabilityTerminal'))
      .toHaveLength(1);
    expect(fixture.observed.capabilityPrepareCount).toBe(1);
    await expect(runtime.inspectUnresolvedCapabilityDispatches(64)).resolves.toEqual([]);
    await runtime.cancelActive(result.authority, {
      reason: agentV1Runtime.CancelReason.USER_REQUEST,
      reasonCode: 'codex_b2_soak_iteration_complete',
      graceDeadlineAtUnixMs: BigInt(Date.now() + 750),
      idempotencyKey: `codex-b2-soak:${iteration}`,
    });
    await runtime.waitForPhysicalReap();
    expect(fixture.committedFacts).toEqual([
      'launchAccepted',
      'attemptProcessSpawned',
      'attemptContainmentReport',
      'attemptProcessExited',
      'attemptProcessReaped',
    ]);
    expect(fixture.observed.containment?.effectiveContainment).toMatchObject({
      level: agentV1Common.ContainmentLevel.HARD_AGGREGATE,
      capabilities: { processTree: true },
    });
    const peakResidentMemoryBytes = fixture.observed.finalResources
      ?.peakResidentMemoryBytes ?? 0n;
    expect(peakResidentMemoryBytes).toBeGreaterThan(0n);
    expect(peakResidentMemoryBytes).toBeLessThanOrEqual(MEMORY_LIMIT_BYTES);
    return {
      iteration,
      elapsedMs: Math.round(performance.now() - started),
      peakResidentMemoryBytes,
      maximumProcessCount,
      journalRecords: records.length,
    };
  } catch (cause) {
    const recordCases = await readProcessRealEngineEvents(fixture)
      .then((records) => records.map(({ body }) => body.case).join(','))
      .catch(() => 'unavailable');
    const receipt = await runtime.close().catch(() => undefined);
    closed = true;
    throw new Error(
      `B2 soak iteration ${iteration} failed; facts=${fixture.committedFacts.join(',')}`
        + ` supervisor=${runtime.supervisorProcessId}`
        + ` receipt=${receipt ? `${receipt.exitCode}/${receipt.forced}` : 'unavailable'}`
        + ` runtimeFailed=${runtime.isFailed}`
        + ` runtimeCause=${String(runtime.failureCause ?? 'none')}`
        + ` dataCause=${String(fixture.observed.sourceCloseCause ?? 'none')}`
        + ` exitCause=${String(fixture.observed.exitCause ?? 'none')}`
        + ` records=${recordCases}`,
      { cause },
    );
  } finally {
    if (!closed) await runtime.close().catch(() => undefined);
    await rm(fixture.sessionRoot!, { recursive: true, force: true });
  }
}

async function waitForTerminal(
  fixture: ProcessRealFixture,
  sample: () => void,
  timeout: number,
): Promise<agentV1SessionStore.EngineEventRecordV1[]> {
  let records: agentV1SessionStore.EngineEventRecordV1[] = [];
  await vi.waitFor(async () => {
    sample();
    records = await readProcessRealEngineEvents(fixture);
    expect(records.some(({ body }) => body.case === 'terminal')).toBe(true);
  }, { timeout, interval: 100 });
  return records;
}

function assertSoak(
  metrics: readonly IterationMetric[],
  expected: number,
  minimumProcessCount: number,
): void {
  expect(metrics).toHaveLength(expected);
  expect(metrics.every(({ maximumProcessCount }) =>
    maximumProcessCount >= minimumProcessCount)).toBe(true);
  expect(metrics.every(({ peakResidentMemoryBytes }) =>
    peakResidentMemoryBytes > 0n && peakResidentMemoryBytes <= MEMORY_LIMIT_BYTES)).toBe(true);
}

function emit(kind: string, metrics: readonly IterationMetric[]): void {
  const peaks = metrics.map(({ peakResidentMemoryBytes }) => peakResidentMemoryBytes);
  const elapsed = metrics.map(({ elapsedMs }) => elapsedMs);
  process.stdout.write(`${JSON.stringify({
    kind,
    iterations: metrics.length,
    elapsedMs: { minimum: Math.min(...elapsed), maximum: Math.max(...elapsed) },
    peakResidentMemoryBytes: {
      minimum: String(peaks.reduce((left, right) => left < right ? left : right)),
      maximum: String(peaks.reduce((left, right) => left > right ? left : right)),
    },
    maximumProcessCount: Math.max(...metrics.map((metric) => metric.maximumProcessCount)),
    journalRecordRange: {
      minimum: Math.min(...metrics.map((metric) => metric.journalRecords)),
      maximum: Math.max(...metrics.map((metric) => metric.journalRecords)),
    },
  })}\n`);
}

function validBinary(value: unknown): value is string {
  return typeof value === 'string' && isAbsolute(value) && existsSync(value);
}
