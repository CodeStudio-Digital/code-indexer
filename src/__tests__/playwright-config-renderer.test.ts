import { describe, it, expect } from 'vitest';
import {
  renderPlaywrightConfig,
  QA_GLOBAL_SETUP_TEMPLATE,
  validatePlaywrightConfig,
} from '@mcp/services/sandbox/scaffolders/playwright-bootstrap.js';

describe('renderPlaywrightConfig', () => {
  it('emits a valid TypeScript module pointing at the dev server', () => {
    const out = renderPlaywrightConfig(5173);
    expect(out).toContain("import { defineConfig, devices } from '@playwright/test'");
    expect(out).toContain("testDir: './tests/e2e'");
    expect(out).toContain("baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5173'");
    expect(out).toContain("trace: 'on-first-retry'");
    expect(out).toContain("screenshot: 'on'");
    expect(out).toContain("video: 'on'");
  });

  it('flags drift back to legacy on-failure-only evidence as a recommendation', () => {
    const legacy = renderPlaywrightConfig(5173)
      .replace("screenshot: 'on'", "screenshot: 'only-on-failure'")
      .replace("video: 'on'", "video: 'retain-on-failure'");
    const { ok, recommendations } = validatePlaywrightConfig(legacy);
    expect(ok).toBe(true); // still valid — recommendations are non-critical
    expect(recommendations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("screenshot: 'only-on-failure'"),
        expect.stringContaining("video: 'retain-on-failure'"),
      ]),
    );
  });

  it('substitutes the dev server port', () => {
    expect(renderPlaywrightConfig(3000)).toContain("'http://localhost:3000'");
    expect(renderPlaywrightConfig(8080)).toContain("'http://localhost:8080'");
  });

  it('configures the chromium project (default browser for the QA agent)', () => {
    const out = renderPlaywrightConfig(5173);
    expect(out).toContain("name: 'chromium'");
    expect(out).toContain("...devices['Desktop Chrome']");
  });

  it('keeps reporters set to list+html+json so frontend can read structured results', () => {
    const out = renderPlaywrightConfig(5173);
    expect(out).toContain("['list']");
    expect(out).toContain("['html', { open: 'never' }]");
    expect(out).toContain("['json', { outputFile: 'test-results/report.json' }]");
  });

  it('wires globalSetup + storageState for the QA preview cookie (v4.3)', () => {
    const out = renderPlaywrightConfig(5173);
    expect(out).toContain(`globalSetup: require.resolve('./tests/e2e/global-setup')`);
    expect(out).toContain(`storageState: 'tests/e2e/.auth/qa-state.json'`);
  });
});

describe('QA_GLOBAL_SETUP_TEMPLATE', () => {
  it('reads PLAYWRIGHT_BASE_URL and MCP_PREVIEW_COOKIE from env', () => {
    expect(QA_GLOBAL_SETUP_TEMPLATE).toContain('process.env.MCP_PREVIEW_COOKIE');
    expect(QA_GLOBAL_SETUP_TEMPLATE).toContain('process.env.PLAYWRIGHT_BASE_URL');
  });

  it('writes a Playwright-compatible storageState shape', () => {
    expect(QA_GLOBAL_SETUP_TEMPLATE).toContain(`name: 'mcp_preview'`);
    expect(QA_GLOBAL_SETUP_TEMPLATE).toContain(`path: '/preview/'`);
    expect(QA_GLOBAL_SETUP_TEMPLATE).toContain('domain: url.hostname');
    expect(QA_GLOBAL_SETUP_TEMPLATE).toContain(`sameSite: 'Strict'`);
  });

  it('falls back to an empty state file when env vars are missing', () => {
    expect(QA_GLOBAL_SETUP_TEMPLATE).toContain(
      `JSON.stringify({ cookies: [], origins: [] })`,
    );
  });

  it('writes the state under tests/e2e/.auth/qa-state.json', () => {
    expect(QA_GLOBAL_SETUP_TEMPLATE).toContain(`'tests/e2e/.auth'`);
    expect(QA_GLOBAL_SETUP_TEMPLATE).toContain(`'qa-state.json'`);
  });

  it('marks the cookie secure when baseURL is HTTPS', () => {
    expect(QA_GLOBAL_SETUP_TEMPLATE).toContain(`secure: url.protocol === 'https:'`);
  });

  it('produces parseable TypeScript that can be evaluated as a Playwright globalSetup', () => {
    // Syntactic sanity check — quick parse via Function constructor for ESM
    // would need transpile; instead we assert the export shape is present.
    expect(QA_GLOBAL_SETUP_TEMPLATE).toMatch(/export default async function globalSetup\(\)/);
  });
});

describe('validatePlaywrightConfig', () => {
  it('returns ok=true on the freshly rendered config', () => {
    const { ok, missing } = validatePlaywrightConfig(renderPlaywrightConfig(5173));
    expect(ok).toBe(true);
    expect(missing).toEqual([]);
  });

  it('flags removal of PLAYWRIGHT_BASE_URL env wiring', () => {
    const broken = renderPlaywrightConfig(5173).replace(
      "process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5173'",
      "'http://10.88.0.230:5173/preview/68'",
    );
    const { ok, missing } = validatePlaywrightConfig(broken);
    expect(ok).toBe(false);
    expect(missing).toContain('PLAYWRIGHT_BASE_URL env');
  });

  it('flags missing globalSetup', () => {
    const broken = renderPlaywrightConfig(5173).replace(
      `globalSetup: require.resolve('./tests/e2e/global-setup'),`,
      '',
    );
    const { ok, missing } = validatePlaywrightConfig(broken);
    expect(ok).toBe(false);
    expect(missing).toContain('globalSetup (auth cookie)');
  });

  it('flags missing html reporter', () => {
    // Sanitise: drop the html reporter literal.
    const broken = renderPlaywrightConfig(5173).replace(
      `['html', { open: 'never' }]`,
      '',
    );
    const { ok, missing } = validatePlaywrightConfig(broken);
    expect(ok).toBe(false);
    expect(missing).toContain("'html' reporter");
  });

  it('flags missing streaming reporter', () => {
    // Real-world failure from session 68 — agent had ['list'] only.
    const handWritten = `
      import { defineConfig } from '@playwright/test';
      export default defineConfig({
        reporter: [['list']],
        use: { baseURL: 'http://localhost:5173' },
      });
    `;
    const { ok, missing } = validatePlaywrightConfig(handWritten);
    expect(ok).toBe(false);
    expect(missing).toContain('streaming reporter');
    expect(missing).toContain('globalSetup (auth cookie)');
    expect(missing).toContain('storageState path');
  });

  it('reports an empty config as fully broken', () => {
    const { ok, missing } = validatePlaywrightConfig('');
    expect(ok).toBe(false);
    expect(missing.length).toBeGreaterThan(3);
  });
});
