import { describe, expect, it } from 'vitest';
import { certifyOssEngineRun } from '../engine-bakeoff/CertificationGate.js';
import {
  dynamicToolAlias,
  validateOssEngineAttemptSpec,
  validateToolReceipt,
} from '../engine-bakeoff/validation.js';
import { ossAttemptSpec } from './oss-engine-support.js';

describe('OSS engine validation and certification', () => {
  it('creates stable provider-safe aliases without using friendly names as identity', () => {
    const capability = ossAttemptSpec().capabilities[0]!;
    const first = dynamicToolAlias(capability);
    const second = dynamicToolAlias({ ...capability, canonicalName: 'search code' });

    expect(first).toMatch(/^search_code_[a-f0-9]{12}$/);
    expect(second).toBe(first);
  });

  it('rejects duplicate capability identities and oversized schema projections', () => {
    const capability = ossAttemptSpec().capabilities[0]!;
    expect(() => validateOssEngineAttemptSpec(ossAttemptSpec({
      capabilities: [capability, capability],
    }))).toThrow(expect.objectContaining({ code: 'duplicate_capability_id' }));

    expect(() => validateOssEngineAttemptSpec(ossAttemptSpec({
      capabilities: [{
        ...capability,
        inputSchema: { type: 'object', description: 'x'.repeat(1024) },
      }],
    }), {
      maxCapabilities: 2,
      maxSchemaBytes: 64,
      maxToolResultBytes: 1024,
    })).toThrow(expect.objectContaining({ code: 'schema_budget_exceeded' }));
  });

  it('requires pinned SHA-256 digests and a coherent ToolHost lifecycle receipt', () => {
    const capability = ossAttemptSpec().capabilities[0]!;
    expect(() => validateOssEngineAttemptSpec(ossAttemptSpec({
      capabilities: [{ ...capability, descriptorDigest: 'mutable' }],
    }))).toThrow(expect.objectContaining({ code: 'capability_digest_invalid' }));

    expect(() => validateToolReceipt({
      callId: 'call-1',
      accepted: false,
      started: true,
      outcome: 'declined',
      contentItems: [],
    }, 'call-1', 1024)).toThrow(expect.objectContaining({
      code: 'tool_receipt_invalid_lifecycle',
    }));
  });

  it('rejects a candidate run that bypassed ToolHost', () => {
    const report = certifyOssEngineRun({
      result: {
        candidate: 'codex_app_server',
        candidateVersion: 'test',
        protocolVersion: 'v2',
        protocolSchemaDigest: 'b'.repeat(64),
        attemptId: 'attempt-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
        status: 'completed',
        metrics: {
          startedAt: '2026-08-04T00:00:00.000Z',
          completedAt: '2026-08-04T00:00:01.000Z',
          initializeMs: 1,
          threadStartMs: 1,
          turnStartMs: 1,
          dynamicToolCount: 1,
          toolCallCount: 0,
          deniedBuiltInRequestCount: 0,
          observedBypassToolCount: 1,
          temporaryStateDeleted: true,
        },
      },
      dynamicToolApiStable: false,
      supervisorOwned: false,
      processTreeReaped: true,
      resourceLimitsEnforced: true,
    });

    expect(report.status).toBe('rejected');
    expect(report.blockers).toContain('tool_host_bypass_observed');
    expect(report.blockers).toContain('durable_supervisor_ownership_not_proven');
    expect(report.observations).toContain('dynamic_tool_api_is_experimental');
  });
});
