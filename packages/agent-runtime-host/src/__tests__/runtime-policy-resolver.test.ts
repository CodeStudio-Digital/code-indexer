import { describe, expect, it } from 'vitest';
import {
  canonicalRuntimePolicyJson,
  legacyRuntimePolicyLayerFromEnv,
  resolveRuntimePolicyV1,
  sealResolvedRuntimePolicyV1,
} from '../runtime-policy/index.js';

describe('RuntimePolicyResolver', () => {
  it('resolves a deterministic default snapshot without timestamp-dependent digest', () => {
    const first = resolveRuntimePolicyV1({ resolvedAt: '2026-08-05T10:00:00.000Z' });
    const second = resolveRuntimePolicyV1({ resolvedAt: '2026-08-05T11:00:00.000Z' });

    expect(first.policyDigest).toBe(second.policyDigest);
    expect(first.policyId).toBe(second.policyId);
    expect(first.context.toolResultChars).toBe(24_000);
    expect(first.diagnostics.redactSensitiveValues).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.provider)).toBe(true);
    expect(Object.isFrozen(first.provenance)).toBe(true);
  });

  it('applies the normative precedence and retains per-field provenance', () => {
    const policy = resolveRuntimePolicyV1({
      deployment: { revision: 'deploy-7', values: { context: { toolResultChars: 30_000 } } },
      operator: { revision: 'operator-9', values: { context: { toolResultChars: 40_000 } } },
      preset: { revision: 'preset-build-v2', values: { context: { toolResultChars: 50_000 } } },
      request: { revision: 'request-13', values: { context: { toolResultChars: 60_000 } } },
    });

    expect(policy.context.toolResultChars).toBe(60_000);
    expect(policy.provenance.find((item) => item.path === 'context.toolResultChars')).toEqual({
      path: 'context.toolResultChars',
      value: 60_000,
      source: 'request',
      sourceRevision: 'request-13',
    });
  });

  it('applies safety clamps without losing the original source', () => {
    const policy = resolveRuntimePolicyV1({
      operator: { revision: 'operator-2', values: { subagents: { maxParallel: 12 } } },
      clamps: [{
        path: 'subagents.maxParallel',
        max: 4,
        clampId: 'host-process-grant',
        revision: 'grant-44',
      }],
    });

    expect(policy.subagents.maxParallel).toBe(4);
    expect(policy.provenance.find((item) => item.path === 'subagents.maxParallel')).toMatchObject({
      source: 'operator',
      sourceRevision: 'operator-2',
      clampedBy: 'host-process-grant@grant-44',
    });
  });

  it('fails closed for unknown, invalid, or secret-shaped fields', () => {
    expect(() => resolveRuntimePolicyV1({
      request: { revision: 'bad', values: { context: { turnBudgetChars: 0 } } },
    })).toThrow('invalid runtime policy value at context.turnBudgetChars');
    expect(() => resolveRuntimePolicyV1({
      request: {
        revision: 'bad',
        values: { provider: { apiKey: 'secret' } } as never,
      },
    })).toThrow('unknown runtime policy field: provider.apiKey');
  });

  it('canonicalizes object keys independently of insertion order', () => {
    expect(canonicalRuntimePolicyJson({ b: 1, a: { d: 4, c: 3 } }))
      .toBe('{"a":{"c":3,"d":4},"b":1}');
  });

  it('migrates legacy env inputs once at attempt launch into typed sections', () => {
    const legacy = legacyRuntimePolicyLayerFromEnv({
      CODER_PROFILE: 'navigate',
      CODER_TOOL_CAP_DEFAULT: '32',
      CODER_DISABLE_SUBAGENTS: '1',
      CODER_PARALLEL_AGENT_MAX: '3',
      CODER_TRANSIENT_RETRY_MAX_PER_TURN: '2',
      CODER_RECOVERY_TRANSIENT_MAX: '12',
      CODER_STREAM_HEARTBEAT_MS: '7000',
      CODER_WORKER_HEAP_MB: '768',
      CODER_WORKER_TTL_MS: '120000',
      CODER_WORKER_POST_RUN_LINGER_MS: '0',
    }, { strict: true, revision: 'legacy-test' });
    const policy = resolveRuntimePolicyV1({ deployment: legacy.layer });

    expect(policy.capabilities).toMatchObject({ profile: 'navigate', visibleToolCap: 32 });
    expect(policy.subagents).toMatchObject({ enabled: false, maxParallel: 3 });
    expect(policy.provider).toMatchObject({
      transientRetriesPerTurn: 2,
      transientRetriesPerRun: 12,
      streamHeartbeatMs: 7_000,
    });
    expect(policy.host).toMatchObject({
      workerHeapMb: 768,
      workerIdleTtlMs: 120_000,
      workerPostRunLingerMs: 0,
    });
  });

  it('rejects conflicting legacy cap aliases instead of guessing precedence', () => {
    expect(() => legacyRuntimePolicyLayerFromEnv({
      CODER_TOOL_CAP_DEFAULT: '28',
      CODER_PREFLIGHT_VISIBLE_CAP: '40',
    }, { strict: true })).toThrow(/CODER_TOOL_CAP_DEFAULT,CODER_PREFLIGHT_VISIBLE_CAP/);
  });

  it('revalidates and deep-freezes a structured-cloned worker snapshot', () => {
    const original = resolveRuntimePolicyV1();
    const clone = structuredClone(original);
    expect(Object.isFrozen(clone.provider)).toBe(false);

    const sealed = sealResolvedRuntimePolicyV1(clone);
    expect(Object.isFrozen(sealed.provider)).toBe(true);
    expect(() => sealResolvedRuntimePolicyV1({
      ...structuredClone(original),
      provider: { ...original.provider, streamHeartbeatMs: 1 },
    })).toThrow(/digest mismatch/);
  });
});
