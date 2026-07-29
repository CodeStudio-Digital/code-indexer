import { describe, it, expect } from 'vitest';
import {
  restoreQaWorkspace,
  renderRunConfigFile,
  emptyReport,
} from '@mcp/services/qa/workspace-restore.js';

/**
 * In-memory fake of `SandboxManager` (only the two methods our helper
 * uses). Lets us assert exactly which workspace files were touched + with
 * what content, without driver/process plumbing.
 */
class FakeManager {
  files = new Map<string, string>();
  /** Optional: simulate read failures by setting `readBehavior`. */
  readBehavior: 'normal' | 'no-sandbox' | 'absent' = 'normal';
  writeFails: Set<string> = new Set();
  removed: string[] = [];

  async writeWorkspaceFile(_sessionId: string, relPath: string, data: string): Promise<void> {
    if (this.writeFails.has(relPath)) {
      throw new Error(`fake write error for ${relPath}`);
    }
    this.files.set(relPath, data);
  }

  async readWorkspaceFile(_sessionId: string, relPath: string): Promise<string | null> {
    if (this.readBehavior === 'no-sandbox') {
      throw new Error('No sandbox for session');
    }
    if (this.readBehavior === 'absent') return null;
    return this.files.get(relPath) ?? null;
  }

  async removeWorkspaceDirOnService(
    _sessionId: string,
    _serviceId: string | undefined,
    relDir: string,
  ): Promise<void> {
    this.removed.push(relDir);
  }
}

const PRISTINE_CONFIG = `
import { defineConfig } from '@playwright/test';
export default defineConfig({
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
    ['json', { outputFile: 'test-results/report.json' }],
    ['./tests/e2e/reporter.ts'],
  ],
  globalSetup: require.resolve('./tests/e2e/global-setup'),
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5173',
    storageState: 'tests/e2e/.auth/qa-state.json',
  },
});
`;

const BROKEN_CONFIG = `
import { defineConfig } from '@playwright/test';
export default defineConfig({
  reporter: [['list']],
  use: {
    baseURL: 'http://10.88.0.230:5173/preview/68',
  },
});
`;
const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const RUN_ID = '00000000-0000-4000-8000-000000000042';

// ─── renderRunConfigFile ────────────────────────────────────────────

describe('renderRunConfigFile (shared)', () => {
  it('produces parseable JSON with runId/endpoint/startedAt', () => {
    const out = renderRunConfigFile(RUN_ID, 'http://x/api');
    const parsed = JSON.parse(out);
    expect(parsed.runId).toBe(RUN_ID);
    expect(parsed.endpoint).toBe('http://x/api');
    expect(typeof parsed.startedAt).toBe('string');
  });
});

// ─── restoreQaWorkspace ────────────────────────────────────────────

describe('restoreQaWorkspace', () => {
  it('writes reporter + global-setup; skips run-config when not asked', async () => {
    const m = new FakeManager();
    const r = await restoreQaWorkspace(m, { sessionId: SESSION_ID });
    expect(r.reporterRestored).toBe(true);
    expect(r.globalSetupRestored).toBe(true);
    expect(r.runConfigWritten).toBe(false);
    expect(m.files.has('tests/e2e/reporter.ts')).toBe(true);
    expect(m.files.has('tests/e2e/global-setup.ts')).toBe(true);
    expect(m.files.has('tests/e2e/.mcp-qa-run.json')).toBe(false);
  });

  it('writes run config when caller passes one (qa_start_run path)', async () => {
    const m = new FakeManager();
    const r = await restoreQaWorkspace(m, {
      sessionId: SESSION_ID,
      runConfig: { runId: RUN_ID, endpoint: 'http://x/api' },
    });
    expect(r.runConfigWritten).toBe(true);
    const written = m.files.get('tests/e2e/.mcp-qa-run.json')!;
    const parsed = JSON.parse(written);
    expect(parsed.runId).toBe(RUN_ID);
    expect(parsed.endpoint).toBe('http://x/api');
  });

  it('reports configMissing=[] for a pristine config', async () => {
    const m = new FakeManager();
    m.files.set('playwright.config.ts', PRISTINE_CONFIG);
    const r = await restoreQaWorkspace(m, { sessionId: SESSION_ID });
    expect(r.configMissing).toEqual([]);
    expect(r.configRecommendedWritten).toBe(false);
    expect(m.files.has('playwright.config.recommended.ts')).toBe(false);
  });

  it('writes .recommended sibling when config has drifted', async () => {
    const m = new FakeManager();
    m.files.set('playwright.config.ts', BROKEN_CONFIG);
    const r = await restoreQaWorkspace(m, { sessionId: SESSION_ID });
    expect(r.configMissing.length).toBeGreaterThan(0);
    expect(r.configRecommendedWritten).toBe(true);
    expect(m.files.has('playwright.config.recommended.ts')).toBe(true);
  });

  it('does NOT write .recommended when config is absent', async () => {
    const m = new FakeManager();
    m.readBehavior = 'absent';
    const r = await restoreQaWorkspace(m, { sessionId: SESSION_ID });
    expect(r.configMissing).toEqual([]);
    expect(r.configRecommendedWritten).toBe(false);
  });

  it('collects warnings on read errors but still completes', async () => {
    const m = new FakeManager();
    m.readBehavior = 'no-sandbox';
    const r = await restoreQaWorkspace(m, { sessionId: SESSION_ID });
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.warnings[0]).toMatch(/playwright\.config\.ts/);
    // The reporter / global-setup writes still went through.
    expect(r.reporterRestored).toBe(true);
    expect(r.globalSetupRestored).toBe(true);
  });

  it('emits per-file warning on a write failure', async () => {
    const m = new FakeManager();
    m.writeFails.add('tests/e2e/reporter.ts');
    const r = await restoreQaWorkspace(m, { sessionId: SESSION_ID });
    expect(r.reporterRestored).toBe(false);
    expect(r.globalSetupRestored).toBe(true);
    expect(r.warnings.some((w) => w.includes('tests/e2e/reporter.ts'))).toBe(true);
  });
});

// ─── emptyReport ───────────────────────────────────────────────────

describe('emptyReport', () => {
  it('returns a fresh zero-state object every call', () => {
    const a = emptyReport();
    a.warnings.push('mutated');
    const b = emptyReport();
    expect(b.warnings).toEqual([]);
    expect(b.configMissing).toEqual([]);
  });
});
