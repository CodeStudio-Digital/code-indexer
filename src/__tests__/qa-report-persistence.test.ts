import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  persistRunArtifacts,
  persistAndStamp,
  resolveDefaultMaxBytes,
} from '@mcp/services/qa/report-persistence.js';

/**
 * Unit tests for the host-side artifact persistence helper. Uses a fake
 * SandboxManager surface (matching the helper's `Pick<...>` type) so
 * the tests stay free of containerd dependencies.
 */

class FakeSandboxManager {
  // Map: `${session}::${service}::${dir}` → list of relative paths
  files = new Map<string, string[]>();
  // Map: `${session}::${service}::${path}` → buffer bytes
  bytes = new Map<string, Buffer>();

  registerDir(session: string, service: string | undefined, dir: string, files: Array<[string, Buffer]>): void {
    const key = `${session}::${service ?? 'main'}::${dir}`;
    this.files.set(key, files.map(([p]) => p));
    for (const [rel, buf] of files) {
      this.bytes.set(`${session}::${service ?? 'main'}::${dir}/${rel}`, buf);
    }
  }

  async listWorkspaceFilesOnService(
    session: string,
    service: string | undefined,
    dir: string,
  ): Promise<string[]> {
    return this.files.get(`${session}::${service ?? 'main'}::${dir}`) ?? [];
  }

  async readWorkspaceFileBufferOnService(
    session: string,
    service: string | undefined,
    rel: string,
    opts?: { maxBytes?: number },
  ): Promise<Buffer> {
    const buf = this.bytes.get(`${session}::${service ?? 'main'}::${rel}`);
    if (!buf) throw new Error(`ENOENT: ${rel}`);
    if (opts?.maxBytes && buf.byteLength > opts.maxBytes) {
      throw new Error(`file ${rel} is ${buf.byteLength} bytes, max ${opts.maxBytes}`);
    }
    return buf;
  }
}

describe('persistRunArtifacts', () => {
  let tempBase: string;
  beforeEach(() => {
    tempBase = mkdtempSync(join(tmpdir(), 'mcp-qa-persist-'));
  });
  afterEach(() => {
    rmSync(tempBase, { recursive: true, force: true });
  });

  it('copies files from playwright-report and test-results into the host dir', async () => {
    const fake = new FakeSandboxManager();
    const sessionId = '00000000-0000-4000-8000-000000000007';
    const runId = '00000000-0000-4000-8000-000000000042';
    const outputDirectory = join(tempBase, 'company', 'qa-artifacts', runId);
    mkdirSync(outputDirectory, { recursive: true });
    fake.registerDir(sessionId, 'main', 'playwright-report', [
      ['index.html', Buffer.from('<html>report</html>')],
      ['data/run.json', Buffer.from('{"x":1}')],
    ]);
    fake.registerDir(sessionId, 'main', 'test-results', [
      ['login/video.webm', Buffer.from('webm')],
    ]);

    const result = await persistRunArtifacts(fake, {
      sessionId,
      runId,
      serviceId: 'main',
      outputDirectory,
    });

    expect(result.copied).toBe(3);
    expect(result.warnings).toEqual([]);
    expect(readFileSync(join(result.absolutePath, 'playwright-report/index.html'), 'utf8')).toBe(
      '<html>report</html>',
    );
    expect(readFileSync(join(result.absolutePath, 'playwright-report/data/run.json'), 'utf8')).toBe(
      '{"x":1}',
    );
    expect(readFileSync(join(result.absolutePath, 'test-results/login/video.webm'))).toEqual(
      Buffer.from('webm'),
    );
  });

  it('skips files that exceed the per-file cap and lists them as skipped', async () => {
    const fake = new FakeSandboxManager();
    const sessionId = '00000000-0000-4000-8000-000000000007';
    const runId = '00000000-0000-4000-8000-000000000042';
    const outputDirectory = join(tempBase, 'company', 'qa-artifacts', runId);
    mkdirSync(outputDirectory, { recursive: true });
    fake.registerDir(sessionId, 'main', 'playwright-report', [
      ['huge.bin', Buffer.alloc(60 * 1024 * 1024, 0)], // 60 MiB > default 50 MiB cap
      ['small.txt', Buffer.from('ok')],
    ]);

    const result = await persistRunArtifacts(fake, {
      sessionId,
      runId,
      serviceId: 'main',
      outputDirectory,
    });

    expect(result.copied).toBe(1);
    expect(result.skippedTooLarge).toEqual(['playwright-report/huge.bin']);
    expect(readFileSync(join(result.absolutePath, 'playwright-report/small.txt'), 'utf8')).toBe('ok');
  });

  it('respects the per-run total budget and reports skippedBudget', async () => {
    const fake = new FakeSandboxManager();
    const sessionId = '00000000-0000-4000-8000-000000000007';
    const runId = '00000000-0000-4000-8000-000000000042';
    const outputDirectory = join(tempBase, 'company', 'qa-artifacts', runId);
    mkdirSync(outputDirectory, { recursive: true });
    fake.registerDir(sessionId, 'main', 'playwright-report', [
      ['a', Buffer.alloc(2_000)],
      ['b', Buffer.alloc(2_000)],
      ['c', Buffer.alloc(2_000)],
    ]);
    const result = await persistRunArtifacts(fake, {
      sessionId,
      runId,
      serviceId: 'main',
      outputDirectory,
      maxBytes: 4_500, // can fit 2 of 3
    });
    expect(result.copied).toBe(2);
    expect(result.skippedBudget.length).toBe(1);
  });

  it('rejects traversal paths returned by a compromised sandbox driver', async () => {
    const fake = new FakeSandboxManager();
    const sessionId = '00000000-0000-4000-8000-000000000007';
    const runId = '00000000-0000-4000-8000-000000000042';
    const outputDirectory = join(tempBase, 'company', 'qa-artifacts', runId);
    mkdirSync(outputDirectory, { recursive: true });
    fake.registerDir(sessionId, 'main', 'test-results', [
      ['../escape.txt', Buffer.from('no')],
    ]);

    const report = await persistRunArtifacts(fake, {
      sessionId,
      runId,
      serviceId: 'main',
      outputDirectory,
    });
    expect(report.copied).toBe(0);
    expect(report.warnings.join('\n')).toContain('unsafe test-results path');
  });

  it('obtains its destination through the run store and stamps it afterwards', async () => {
    const fake = new FakeSandboxManager();
    const sessionId = '00000000-0000-4000-8000-000000000007';
    const runId = '00000000-0000-4000-8000-000000000042';
    const outputDirectory = join(tempBase, 'bundle', 'company', 'qa-artifacts', runId);
    mkdirSync(outputDirectory, { recursive: true });
    fake.registerDir(sessionId, 'main', 'test-results', [
      ['result.txt', Buffer.from('ok')],
    ]);
    let stamped: string | null = null;
    const store = {
      withRunArtifactDirectory: async <T>(
        ownerId: string,
        ownerRunId: string,
        task: (directory: string) => Promise<T>,
      ): Promise<T> => {
        expect([ownerId, ownerRunId]).toEqual([sessionId, runId]);
        return task(outputDirectory);
      },
      setReportPersistedPath: async (
        ownerRunId: string,
        absolutePath: string | null,
      ): Promise<void> => {
        expect(ownerRunId).toBe(runId);
        stamped = absolutePath;
      },
    };

    const report = await persistAndStamp(fake, store, {
      sessionId,
      runId,
      serviceId: 'main',
    });
    expect(report.copied).toBe(1);
    expect(stamped).toBe(outputDirectory);
  });
});

describe('resolveDefaultMaxBytes', () => {
  const originalMax = process.env.MCP_QA_PERSIST_MAX_BYTES_PER_RUN;
  afterEach(() => {
    if (originalMax === undefined) delete process.env.MCP_QA_PERSIST_MAX_BYTES_PER_RUN;
    else process.env.MCP_QA_PERSIST_MAX_BYTES_PER_RUN = originalMax;
  });

  it('reads MCP_QA_PERSIST_MAX_BYTES_PER_RUN', () => {
    process.env.MCP_QA_PERSIST_MAX_BYTES_PER_RUN = '12345';
    expect(resolveDefaultMaxBytes()).toBe(12345);
  });
});
