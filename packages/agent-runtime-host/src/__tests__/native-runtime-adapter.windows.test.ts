import { fromBinary } from '@bufbuild/protobuf';
import { rm } from 'node:fs/promises';
import { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import { expect, it, vi } from 'vitest';
import { NativeRustAgentRuntimeAdapter } from '../native/NativeRustAgentRuntimeAdapter.js';
import type { PreparedAgentAttempt } from '../facade/types.js';
import type { RuntimeRouteRecord } from '../router/types.js';
import { processRealFixture } from './native-process-real-active-support.js';

const physicalIt = process.platform === 'win32' && process.env.MCP_RUST_AGENT_PROCESS_REAL_E2E === '1' ? it : it.skip;

physicalIt('the facade native adapter launches once and reaps a normally completed attempt', async () => {
  const fixture = await processRealFixture();
  const provision = vi.fn(async () => fixture.options);
  const adapter = new NativeRustAgentRuntimeAdapter({ provision, assertCurrent: async () => {} });
  const spec = fromBinary(agentV1Runtime.ResolvedAttemptSpecSchema, fixture.prepare.encodedSpec);
  const authority = { ...spec.identity, deadlineAtUnixMs: spec.deadlineAtUnixMs,
    leaseExpiresAtUnixMs: spec.deadlineAtUnixMs } as PreparedAgentAttempt['authority'];
  // The facade validates full run/spec provenance separately; this physical
  // boundary checks exact wire identity, digest and packaged build ownership.
  const prepared = { authority, wireSpec: spec,
    expectedSpecSha256: fixture.prepare.expectedSpecSha256 } as PreparedAgentAttempt;
  const route = { ...authority, runtimeGeneration: 'rust_v1',
    runtimeBuildId: fixture.options.runtimePackage.manifest.buildId } as unknown as RuntimeRouteRecord;
  try {
    await Promise.all([adapter.launch(prepared, route), adapter.launch(prepared, route)]);
    await vi.waitFor(() => expect(fixture.committedFacts.at(-1)).toBe('attemptProcessReaped'), { timeout: 15_000 });
    await adapter.cancel(authority, { code: 'late_cancel' });
    expect(provision).toHaveBeenCalledOnce();
    expect(fixture.observed.providerRunCount).toBe(2);
    expect(fixture.observed.capabilityPrepareCount).toBe(1);
    await vi.waitFor(() => {
      expect(() => process.kill(fixture.observed.runnerProcessId!, 0)).toThrow();
    });
  } finally {
    await adapter.cancel(authority, { code: 'test_cleanup' }).catch(() => undefined);
    await rm(fixture.sessionRoot!, { recursive: true, force: true });
  }
}, 120_000);
