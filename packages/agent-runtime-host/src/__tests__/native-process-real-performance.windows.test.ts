import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import { NativeRustHostAttemptRuntime } from '../native/NativeRustHostAttemptRuntime.js';
import { processRealFixture } from './native-process-real-active-support.js';

const enabled = process.platform === 'win32' && process.env.MCP_RUST_AGENT_PERF_E2E === '1';
const physicalIt = enabled ? it : it.skip;

describe('native cancel ACK performance and physical ownership', () => {
  physicalIt('measures warmed ACK latency and verifies both processes have exited', async () => {
    const samples: number[] = [];
    let buildId = '';
    for (let index = 0; index < 55; index++) {
      const fixture = await processRealFixture(false, false);
      buildId = fixture.options.runtimePackage.manifest.buildId;
      const runtime = await NativeRustHostAttemptRuntime.create(fixture.options);
      const supervisorPid = runtime.supervisorProcessId;
      let runnerPid = 0;
      try {
        const launched = await runtime.run(fixture.prepare);
        if (launched.kind !== 'active') throw new Error('performance attempt launch rejected');
        runnerPid = launched.hello.provenance!.pid;
        const started = performance.now();
        await runtime.cancelActive(launched.authority, {
          reason: agentV1Runtime.CancelReason.USER_REQUEST, reasonCode: 'performance_probe',
          graceDeadlineAtUnixMs: BigInt(Date.now() + 750), idempotencyKey: `performance-cancel:${index}`,
        });
        if (index >= 5) samples.push(performance.now() - started);
        await runtime.waitForPhysicalReap();
      } finally { await runtime.close(); }
      for (const pid of [supervisorPid, runnerPid]) {
        expect(pid).toBeGreaterThan(0);
        let alive = false;
        try { process.kill(pid, 0); alive = true; } catch { /* exited */ }
        expect(alive, `owned process ${pid} survived cleanup`).toBe(false);
      }
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const report = {
      buildId, platform: process.platform, arch: process.arch,
      gate: 'cancel_ack_p95', thresholdMs: 250, warmups: 5, samples: samples.length,
      p50Ms: sorted[Math.ceil(sorted.length * .5) - 1]!,
      p95Ms: sorted[Math.ceil(sorted.length * .95) - 1]!,
      maximumMs: sorted.at(-1)!, orphanedProcesses: 0,
      scope: 'Local native Control and Supervisor ACK; idle attempts, no provider or concurrent workload',
    };
    if (process.env.MCP_RUST_AGENT_PERF_REPORT) {
      await writeFile(process.env.MCP_RUST_AGENT_PERF_REPORT, JSON.stringify(report, null, 2));
    }
    process.stdout.write(`${JSON.stringify(report)}\n`);
    expect(report.p95Ms).toBeLessThanOrEqual(report.thresholdMs);
  }, 180_000);
});
