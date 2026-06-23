/**
 * Lightweight Playwright client setup inside a freshly-scaffolded
 * sandbox. Triggered by `ViteScaffolderBase` when `includeE2e === true`.
 *
 * **Why "client"?** The browser does NOT live in the project container.
 * It runs in a separate `playwright-sidecar` container provisioned by
 * `SandboxManager.provisionPlaywrightSidecar`. The project container
 * only carries `@playwright/test` (~12 MB of node modules) and connects
 * to the sidecar via WebSocket using `connectOptions.wsEndpoint`.
 *
 * Steps:
 *  1. `npm i -D @playwright/test` (no browser deps; the sidecar has them)
 *  2. Write `playwright.config.ts` with `connectOptions` reading the
 *     `PLAYWRIGHT_WS_ENDPOINT` env var injected by the manager.
 *  3. Scaffold `tests/e2e/.gitkeep` so the QA agent has a folder ready.
 *  4. Drop the streaming reporter at `tests/e2e/reporter.ts`.
 *
 * Failures are logged but **non-fatal**: the dev server still boots,
 * and the QA agent surfaces a clear diagnostic on first use via
 * `qa_get_browser_endpoint`.
 *
 * **Removed in v3.0** (vs. the v2.x bootstrap):
 *   - `npx playwright-cli install-browser` — no local browser anymore.
 *   - `npx playwright-cli install --skills` — CLI was dropped entirely.
 *   - Chromium healthcheck — now lives in `qa_get_browser_endpoint`,
 *     which probes the sidecar's CDP `/json/version` endpoint.
 */
import type { ISandboxDriver } from '../ports/sandbox-driver.js';
import type { SandboxEvent } from '../types.js';
import { REPORTER_TEMPLATE } from '../../qa/playwright-reporter/reporter-template.js';
import { PINNED_PLAYWRIGHT_TEST_VERSION } from '../../chrome-service/host-alias.js';

export interface PlaywrightBootstrapOpts {
  driver: ISandboxDriver;
  containerId: string;
  workdir: string;
  sandboxId: string;
  emit: (event: SandboxEvent) => void;
  devServerPort: number;
  signal?: AbortSignal;
}

const NPM_INSTALL_TIMEOUT_MS = 180_000;
const WRITE_FILE_TIMEOUT_MS = 10_000;

/**
 * Install the Playwright Test client + write config and reporter into
 * the project container. Renamed from `installPlaywrightAgentCli` to
 * reflect the v3.0 architecture (browser in sidecar, no CLI / no
 * browser install in project).
 */
export async function installPlaywrightTestClient(
  opts: PlaywrightBootstrapOpts,
): Promise<void> {
  const { driver, containerId, workdir, sandboxId, emit, devServerPort, signal } = opts;

  emit({
    kind: 'step',
    sandboxId,
    step: 'installing-deps',
    message: 'Installing @playwright/test client (browser lives in sidecar)…',
  });

  // Pin to the same version as the Chrome Service image. Mismatched
  // major/minor make `chromium.connect()` throw "Looks like Playwright
  // was just updated" — see DEFAULT_CHROME_SERVICE_IMAGE rationale.
  const r1 = await driver.exec(
    containerId,
    `npm i -D @playwright/test@${PINNED_PLAYWRIGHT_TEST_VERSION} --no-audit --no-fund --loglevel=error`,
    { cwd: workdir, timeoutMs: NPM_INSTALL_TIMEOUT_MS, signal },
  );
  if (r1.exitCode !== 0) {
    console.warn(
      `[playwright-bootstrap] npm i @playwright/test failed (non-fatal): ${truncate(r1.stderr || r1.stdout, 600)}`,
    );
    return;
  }

  // Write playwright.config.ts only if absent — never clobber user files.
  // Even though the file is "MCP-managed in spirit", it's also the place
  // users add new test projects, so we don't overwrite once authored.
  // For drift detection see `validatePlaywrightConfig` (called by
  // `qa_start_run` to surface critical-key removals to the agent).
  const checkConfig = await driver.exec(containerId, `test -f ${workdir}/playwright.config.ts`, {
    cwd: undefined,
    timeoutMs: 5_000,
  });
  if (checkConfig.exitCode !== 0) {
    await driver.writeFile(
      containerId,
      `${workdir}/playwright.config.ts`,
      renderPlaywrightConfig(devServerPort),
      { recursive: true },
    );
  }

  await driver.exec(
    containerId,
    `mkdir -p ${workdir}/tests/e2e && touch ${workdir}/tests/e2e/.gitkeep`,
    { cwd: undefined, timeoutMs: WRITE_FILE_TIMEOUT_MS, signal },
  );

  // Reporter is plumbing — overwrite on every provision so accidental
  // edits don't silently break the streaming contract with the dashboard.
  // The file's header explicitly tells the agent NOT to edit it.
  await driver.writeFile(
    containerId,
    `${workdir}/tests/e2e/reporter.ts`,
    REPORTER_TEMPLATE,
    { recursive: true },
  );

  // QA preview-routing global setup (v4.3) — bakes the long-lived
  // `MCP_PREVIEW_COOKIE` into a Playwright `storageState` file so every
  // browser context navigates through the http-api proxy with valid
  // HMAC auth. Lives next to the reporter so user code can find both.
  await driver.writeFile(
    containerId,
    `${workdir}/tests/e2e/global-setup.ts`,
    QA_GLOBAL_SETUP_TEMPLATE,
    { recursive: true },
  );

  // Ignore the auto-generated storage state file. Idempotent — append
  // only if marker not present. Best-effort.
  await driver.exec(
    containerId,
    `grep -q "tests/e2e/.auth" ${workdir}/.gitignore 2>/dev/null || ` +
      `printf '\\n# QA Playwright auto-generated state\\ntests/e2e/.auth/\\n' >> ${workdir}/.gitignore`,
    { cwd: undefined, timeoutMs: WRITE_FILE_TIMEOUT_MS, signal },
  );

  emit({
    kind: 'log',
    sandboxId,
    stream: 'stdout',
    chunk:
      '[playwright-bootstrap] @playwright/test client installed. ' +
      'Browser lives in the playwright-sidecar; specs connect via wsEndpoint.\n',
  });
}

/**
 * Pure renderer for the default `playwright.config.ts`. Connects to the
 * remote browser server via `connectOptions.wsEndpoint`. The env var
 * `PLAYWRIGHT_WS_ENDPOINT` is injected into the container by
 * `SandboxService.provisionIfNeeded` after the sidecar comes up.
 *
 * Exported for snapshot tests — the contract with the sidecar is in
 * the env var name + the `connect` shape.
 */
export function renderPlaywrightConfig(devServerPort: number): string {
  return [
    `// Generated by MCP scaffolder. Safe to edit — re-runs do NOT overwrite.`,
    `//`,
    `// The browser does NOT run in this container. It lives in a separate`,
    `// playwright-sidecar (mcr.microsoft.com/playwright:* image) on the`,
    `// shared docker network. We connect to it via WebSocket — the env`,
    `// var PLAYWRIGHT_WS_ENDPOINT is injected by the MCP SandboxService.`,
    `//`,
    `// IMPORTANT: navigations go through the http-api preview proxy at`,
    `// PLAYWRIGHT_BASE_URL (e.g. http://host.containers.internal:3333/preview/<id>/).`,
    `// Do NOT use 'http://localhost' — inside the Chrome Service container that`,
    `// resolves to itself. The global-setup writes a storageState with the HMAC`,
    `// preview cookie so every browser context inherits valid auth.`,
    `import { defineConfig, devices } from '@playwright/test';`,
    ``,
    `const wsEndpoint = process.env.PLAYWRIGHT_WS_ENDPOINT;`,
    ``,
    `export default defineConfig({`,
    `  testDir: './tests/e2e',`,
    `  timeout: 30_000,`,
    `  expect: { timeout: 5_000 },`,
    `  fullyParallel: true,`,
    `  forbidOnly: !!process.env.CI,`,
    `  retries: process.env.CI ? 2 : 0,`,
    `  // Reporters fire in parallel: list (CLI), HTML (operator's "Open`,
    `  // full HTML report"), JSON (machine-readable), and the bundled`,
    `  // streaming reporter that POSTs events to the dashboard. Do NOT add`,
    `  // \`--reporter=...\` on the CLI — that REPLACES this list and breaks`,
    `  // the live view + HTML report. (See skill v2.5 "Common mistakes".)`,
    `  reporter: [`,
    `    ['list'],`,
    `    ['html', { open: 'never' }],`,
    `    ['json', { outputFile: 'test-results/report.json' }],`,
    `    ['./tests/e2e/reporter.ts'],`,
    `  ],`,
    `  globalSetup: require.resolve('./tests/e2e/global-setup'),`,
    `  use: {`,
    `    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:${devServerPort}',`,
    `    storageState: 'tests/e2e/.auth/qa-state.json',`,
    `    trace: 'on-first-retry',`,
    `    // v4.5: capture evidence on EVERY test (pass or fail). The`,
    `    // dashboard's run detail modal shows thumbnails per row, and`,
    `    // \`MCP_QA_RETAIN_RUNS\` (default 5) prunes the host-side`,
    `    // \`data/qa-reports/<sessionId>/\` so disk usage stays bounded.`,
    `    screenshot: 'on',`,
    `    video: 'on',`,
    `    // Connect to the remote browser; never launch one locally.`,
    `    // If wsEndpoint is missing the run fails fast with a clear error.`,
    `    connectOptions: wsEndpoint ? { wsEndpoint } : undefined,`,
    `  },`,
    `  projects: [`,
    `    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },`,
    `  ],`,
    `});`,
    ``,
  ].join('\n');
}

/**
 * Pure: the `global-setup.ts` script written to `tests/e2e/`.
 * Reads `PLAYWRIGHT_BASE_URL` + `MCP_PREVIEW_COOKIE` and writes a
 * Playwright `storageState` JSON with the cookie scoped to `/preview/`
 * on the proxy host. The config references this storage via
 * `use.storageState`, so every test inherits authenticated context
 * without each spec having to think about the cookie.
 *
 * When env vars are missing (e.g. dev runs the suite outside the
 * MCP-managed env), an EMPTY storage state file is written so the
 * resolved-storageState path still exists; the run will likely fail
 * the proxy 401, but with a clear server-side log.
 *
 * Exported as a constant so the scaffolder writes verbatim and tests
 * can snapshot the bytes.
 */
export const QA_GLOBAL_SETUP_TEMPLATE = [
  `// Generated by MCP scaffolder. Safe to edit — re-runs do NOT overwrite.`,
  `//`,
  `// Bakes the long-lived MCP preview cookie (HMAC, 30d) into a Playwright`,
  `// storageState file so every test goes through the http-api proxy with`,
  `// valid auth. The cookie value is injected as MCP_PREVIEW_COOKIE by the`,
  `// SandboxManager when the session has the qa-playwright skill.`,
  `import fs from 'node:fs';`,
  `import path from 'node:path';`,
  ``,
  `export default async function globalSetup() {`,
  `  const cookie = process.env.MCP_PREVIEW_COOKIE;`,
  `  const baseUrl = process.env.PLAYWRIGHT_BASE_URL;`,
  `  const dir = path.resolve('tests/e2e/.auth');`,
  `  fs.mkdirSync(dir, { recursive: true });`,
  `  const target = path.join(dir, 'qa-state.json');`,
  `  if (!cookie || !baseUrl) {`,
  `    // Write an empty storageState so 'use.storageState' still resolves.`,
  `    // The run will hit a 401 from the proxy with a clear server log.`,
  `    fs.writeFileSync(target, JSON.stringify({ cookies: [], origins: [] }));`,
  `    console.warn('[qa-global-setup] PLAYWRIGHT_BASE_URL or MCP_PREVIEW_COOKIE missing — wrote empty state.');`,
  `    return;`,
  `  }`,
  `  const url = new URL(baseUrl);`,
  `  const state = {`,
  `    cookies: [{`,
  `      name: 'mcp_preview',`,
  `      value: cookie,`,
  `      domain: url.hostname,`,
  `      path: '/preview/',`,
  `      expires: -1,`,
  `      httpOnly: true,`,
  `      secure: url.protocol === 'https:',`,
  `      sameSite: 'Strict',`,
  `    }],`,
  `    origins: [],`,
  `  };`,
  `  fs.writeFileSync(target, JSON.stringify(state));`,
  `}`,
  ``,
].join('\n');

function truncate(s: string, max: number): string {
  if (!s) return '';
  return s.length <= max ? s : `${s.slice(0, max)}…(truncated)`;
}

// ─── v4.4: drift detection + force-restore ────────────────────────

/**
 * Critical keys that MUST appear in `playwright.config.ts` for the QA
 * pipeline to function. Pure: returns the list of missing tokens. The
 * matcher is substring-based (not AST) — agents customize formatting,
 * so we just check for the literal we wrote in the template.
 *
 * - `process.env.PLAYWRIGHT_BASE_URL` — proxy routing (v4.3).
 * - `tests/e2e/global-setup` — HMAC cookie injection.
 * - `tests/e2e/.auth/qa-state.json` — storageState path.
 * - `'html'` reporter — the operator's "Open full HTML report" button.
 * - `'./tests/e2e/reporter.ts'` — streaming reporter (Tab Testes Live).
 */
export function validatePlaywrightConfig(content: string): {
  ok: boolean;
  missing: string[];
  /** v4.5 — non-critical drift the operator should know about (yellow). */
  recommendations: string[];
} {
  const required: Array<{ key: string; needle: string }> = [
    { key: 'PLAYWRIGHT_BASE_URL env', needle: 'process.env.PLAYWRIGHT_BASE_URL' },
    { key: 'globalSetup (auth cookie)', needle: 'tests/e2e/global-setup' },
    { key: 'storageState path', needle: 'tests/e2e/.auth/qa-state.json' },
    { key: "'html' reporter", needle: "'html'" },
    { key: 'streaming reporter', needle: 'tests/e2e/reporter' },
  ];
  const missing = required.filter((r) => !content.includes(r.needle)).map((r) => r.key);

  // Soft recommendations — don't fail the validate but surface for the
  // diagnostics panel. Useful when old configs (pre-v4.5) drift away
  // from the new evidence-on-every-test defaults.
  const recommendations: string[] = [];
  if (/screenshot:\s*['"]only-on-failure['"]/.test(content)) {
    recommendations.push(
      "screenshot: 'only-on-failure' — v4.5 default is 'on' so passing tests also produce evidence",
    );
  }
  if (/video:\s*['"]retain-on-failure['"]/.test(content)) {
    recommendations.push(
      "video: 'retain-on-failure' — v4.5 default is 'on' for full audit trail on every test",
    );
  }
  return { ok: missing.length === 0, missing, recommendations };
}

/**
 * Force-restore the reporter file. Called by `qa_start_run` (v4.4) so
 * an accidentally edited reporter doesn't silently break a run. Cheap —
 * a single writeFile per run start.
 */
export async function restoreQaReporter(opts: {
  driver: ISandboxDriver;
  containerId: string;
  workdir: string;
  signal?: AbortSignal;
}): Promise<void> {
  const { driver, containerId, workdir, signal } = opts;
  void signal;
  await driver.writeFile(
    containerId,
    `${workdir}/tests/e2e/reporter.ts`,
    REPORTER_TEMPLATE,
    { recursive: true },
  );
}

/**
 * Force-restore the global-setup file. Pairs with `restoreQaReporter`
 * so the v4.3 cookie-injection contract is healed at the same time the
 * reporter is. Idempotent.
 */
export async function restoreQaGlobalSetup(opts: {
  driver: ISandboxDriver;
  containerId: string;
  workdir: string;
  signal?: AbortSignal;
}): Promise<void> {
  const { driver, containerId, workdir, signal } = opts;
  void signal;
  await driver.writeFile(
    containerId,
    `${workdir}/tests/e2e/global-setup.ts`,
    QA_GLOBAL_SETUP_TEMPLATE,
    { recursive: true },
  );
}
