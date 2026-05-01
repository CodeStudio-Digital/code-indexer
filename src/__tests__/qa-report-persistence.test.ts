import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  persistRunArtifacts,
  pruneOldRunDirs,
  resolveRunReportDir,
  resolveRetainRuns,
  resolveDefaultMaxBytes,
} from '../core/qa/report-persistence.js';

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
    fake.registerDir('7', 'main', 'playwright-report', [
      ['index.html', Buffer.from('<html>report</html>')],
      ['data/run.json', Buffer.from('{"x":1}')],
    ]);
    fake.registerDir('7', 'main', 'test-results', [
      ['login/video.webm', Buffer.from('webm')],
    ]);

    const result = await persistRunArtifacts(fake, {
      sessionId: 7,
      runId: 42,
      serviceId: 'main',
      baseDir: tempBase,
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
    fake.registerDir('7', 'main', 'playwright-report', [
      ['huge.bin', Buffer.alloc(60 * 1024 * 1024, 0)], // 60 MiB > default 50 MiB cap
      ['small.txt', Buffer.from('ok')],
    ]);

    const result = await persistRunArtifacts(fake, {
      sessionId: 7,
      runId: 42,
      serviceId: 'main',
      baseDir: tempBase,
    });

    expect(result.copied).toBe(1);
    expect(result.skippedTooLarge).toEqual(['playwright-report/huge.bin']);
    expect(readFileSync(join(result.absolutePath, 'playwright-report/small.txt'), 'utf8')).toBe('ok');
  });

  it('respects the per-run total budget and reports skippedBudget', async () => {
    const fake = new FakeSandboxManager();
    fake.registerDir('7', 'main', 'playwright-report', [
      ['a', Buffer.alloc(2_000)],
      ['b', Buffer.alloc(2_000)],
      ['c', Buffer.alloc(2_000)],
    ]);
    const result = await persistRunArtifacts(fake, {
      sessionId: 7,
      runId: 42,
      serviceId: 'main',
      baseDir: tempBase,
      maxBytes: 4_500, // can fit 2 of 3
    });
    expect(result.copied).toBe(2);
    expect(result.skippedBudget.length).toBe(1);
  });
});

describe('resolveRunReportDir', () => {
  it('joins MCP_DATA_DIR with sessionId/runId', () => {
    expect(resolveRunReportDir(7, 42, '/data')).toBe(
      // path.resolve normalises so this matches OS sep
      require('node:path').resolve('/data/qa-reports/7/42'),
    );
  });
});

describe('pruneOldRunDirs', () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'mcp-qa-prune-'));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('keeps the last N numeric runIds and removes the rest', async () => {
    const sessionDir = join(base, 'qa-reports', '9');
    mkdirSync(sessionDir, { recursive: true });
    for (const id of [1, 2, 3, 4, 5, 6, 7]) {
      mkdirSync(join(sessionDir, String(id)));
      writeFileSync(join(sessionDir, String(id), 'marker.txt'), String(id));
    }
    const out = await pruneOldRunDirs(9, 3, base);
    expect(out.removed.length).toBe(4);
    expect(existsSync(join(sessionDir, '1'))).toBe(false);
    expect(existsSync(join(sessionDir, '4'))).toBe(false);
    expect(existsSync(join(sessionDir, '5'))).toBe(true);
    expect(existsSync(join(sessionDir, '6'))).toBe(true);
    expect(existsSync(join(sessionDir, '7'))).toBe(true);
  });

  it('returns an empty result when the session dir does not exist', async () => {
    const out = await pruneOldRunDirs(404, 3, base);
    expect(out.removed).toEqual([]);
    expect(out.warnings).toEqual([]);
  });
});

describe('resolveRetainRuns / resolveDefaultMaxBytes', () => {
  const originalRetain = process.env.MCP_QA_RETAIN_RUNS;
  const originalMax = process.env.MCP_QA_PERSIST_MAX_BYTES_PER_RUN;
  afterEach(() => {
    if (originalRetain === undefined) delete process.env.MCP_QA_RETAIN_RUNS;
    else process.env.MCP_QA_RETAIN_RUNS = originalRetain;
    if (originalMax === undefined) delete process.env.MCP_QA_PERSIST_MAX_BYTES_PER_RUN;
    else process.env.MCP_QA_PERSIST_MAX_BYTES_PER_RUN = originalMax;
  });

  it('reads MCP_QA_RETAIN_RUNS', () => {
    process.env.MCP_QA_RETAIN_RUNS = '12';
    expect(resolveRetainRuns()).toBe(12);
  });

  it('falls back to 5 when MCP_QA_RETAIN_RUNS is invalid', () => {
    process.env.MCP_QA_RETAIN_RUNS = 'oops';
    expect(resolveRetainRuns()).toBe(5);
  });

  it('reads MCP_QA_PERSIST_MAX_BYTES_PER_RUN', () => {
    process.env.MCP_QA_PERSIST_MAX_BYTES_PER_RUN = '12345';
    expect(resolveDefaultMaxBytes()).toBe(12345);
  });
});
