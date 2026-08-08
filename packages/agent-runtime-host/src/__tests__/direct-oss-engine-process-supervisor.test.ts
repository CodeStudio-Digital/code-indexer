import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DirectOssEngineProcessSupervisor,
  type OssEngineProcessLaunchRequest,
} from '../index.js';

describe('DirectOssEngineProcessSupervisor', () => {
  it('closes the root process but never claims process-tree ownership or reap proof', async () => {
    const supervisor = new DirectOssEngineProcessSupervisor();
    const deadlineAtUnixMs = BigInt(Date.now() + 10_000);
    const request: OssEngineProcessLaunchRequest = {
      candidate: 'codex_app_server',
      candidateVersion: 'fixture',
      protocolVersion: 'fixture-v1',
      protocolSchemaDigest: createHash('sha256').update('fixture').digest('hex'),
      attemptId: '44444444-4444-4444-8444-444444444444',
      executable: process.execPath,
      arguments: ['-e', 'process.stdin.resume()'],
      workingDirectory: process.cwd(),
      environment: {
        ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
      },
      resourceBudget: {
        maxMemoryBytes: 128n * 1024n * 1024n,
        maxCpuTimeMs: 5_000n,
        maxWallTimeMs: 10_000n,
        maxProcesses: 1,
        maxOpenHandles: 128,
      },
      requiredEnforcedLimits: ['memory', 'cpu_time', 'wall_time', 'processes'],
      deadlineAtUnixMs,
    };

    const lease = await supervisor.launch(request, new AbortController().signal);
    expect(lease.launchReceipt).toMatchObject({
      source: 'direct_process',
      containmentLevel: 'unavailable',
      processTreeOwned: false,
      enforcedLimits: [],
    });

    const finalization = await lease.finalize({
      disposition: 'completed',
      deadlineAtUnixMs,
    });
    expect(finalization).toMatchObject({
      status: 'ownership_retained',
      disposition: 'completed',
    });
    expect(finalization.reason).toMatch(/^direct_process_tree_unproven:root_exit=/);
  });
});
