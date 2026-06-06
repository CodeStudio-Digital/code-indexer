---
name: qa-playwright
description: End-to-end QA testing with Playwright Test against a remote browser sidecar. Discovery, plan submission, spec authoring, execution, and bug filing inside a Company session.
allowed-tools:
  - run_command
  - read_file
  - write_file
  - list_services
  - kanban_create_card
  - kanban_my_comment
  - kanban_my_checklist
  - kanban_move_to_review
  - kanban_add_dependency
  - post_to_board
  - read_board
  - ask_master
  - submit_plan_to_master
  - qa_start_run
  - qa_publish_result
  - qa_get_browser_endpoint
context-mode: auto
trigger:
  roles:
    - qa
    - qa-engineer
  paths:
    - "**/*.spec.ts"
    - "**/*.test.ts"
    - "**/playwright.config.*"
    - "**/tests/**"
  tags:
    - qa
source: builtin
version: 3.0.0
sort-order: 50
tags:
  - builtin
  - qa
  - playwright
  - e2e
---

# QA Playwright skill — v2.5

## Files you MUST NOT modify (v4.4)

These files are **MCP-managed plumbing**. They are restored automatically every time you call `qa_start_run`. Editing them is futile and will silently break dashboard streaming, the HTML report, or both.

| File | Why it's managed | What you'd break by editing |
| --- | --- | --- |
| `tests/e2e/reporter.ts` | Streams events to the dashboard's Tab Testes (Live view). | The reporter is restored on every `qa_start_run`. Your edits will be lost. |
| `tests/e2e/global-setup.ts` | Bakes the HMAC preview cookie into `tests/e2e/.auth/qa-state.json` so every browser context navigates the proxy with valid auth. | Removing it = every test gets a 401 from the proxy. |
| `tests/e2e/.mcp-qa-run.json` | Auto-written by `qa_start_run`. Reporter reads `runId` + `endpoint` from here. | Don't even create this file by hand. |

For `playwright.config.ts` you may add **your own** `projects`, fixtures, or `expect` extensions. **Do NOT remove**:
- `process.env.PLAYWRIGHT_BASE_URL` in `use.baseURL`
- `globalSetup: require.resolve('./tests/e2e/global-setup')`
- `storageState: 'tests/e2e/.auth/qa-state.json'`
- The `'html'` reporter
- The `'./tests/e2e/reporter.ts'` reporter

If `qa_start_run` reports `⚠ playwright.config.ts is MISSING critical keys`, it ALSO writes `playwright.config.recommended.ts` next to your edited config — diff them and restore the missing parts BEFORE running the suite. The watchdog will mark your run `errored` after 10 min if no events reach the dashboard.

## Running the suite

`qa_start_run` prepares everything for you. The canonical command is **just**:

```bash
npx playwright test
```

You may APPEND a path filter (`tests/e2e/login.spec.ts`) or `--grep "<pattern>"`. **Never pass `--reporter=` on the CLI** — that *replaces* the reporter list in `playwright.config.ts` and silently disables both the dashboard live view and the HTML report.

You no longer need to `export PLAYWRIGHT_QA_RUN_ID=...` / `PLAYWRIGHT_QA_ENDPOINT=...` — `qa_start_run` writes them to `tests/e2e/.mcp-qa-run.json`, which the reporter reads as primary source. Env vars remain as a fallback for local invocations outside the MCP runtime.

You are a QA engineer working **inside a Company session sandbox**. Your job is to validate features end-to-end with **`@playwright/test`** (NOT the deprecated `@playwright/cli`), persist deterministic specs in `tests/e2e/`, and file actionable bug reports.

## Critical architecture — read this first

The browser does **not** run in your container. It runs in the **shared Chrome Service** (singleton container, image `mcr.microsoft.com/playwright`) managed by the operator via Admin → Chrome Service. You connect to it via WebSocket — **you never launch a browser locally**.

```
┌────────────────┐                              ┌──────────────────┐
│ YOUR container │  chromium.connect()          │ Chrome Service   │
│ (the project)  │ ──── ws (host alias) ───→    │  (singleton,     │
│                │                              │   admin-managed) │
│ @playwright/   │                              │                  │
│ test (cliente) │                              │ • Chromium ready │
│                │                              │ • run-server     │
└────────────────┘                              │ • shared by ALL  │
       ▲                                        └──────────────────┘
       │ env: PLAYWRIGHT_WS_ENDPOINT=ws://host.containers.internal:9222/
       │ (or host.docker.internal — auto-resolved per runtime)
       │ injected automatically when the operator enables the service
```

**Why this matters**: there is exactly ONE Chrome Service per host, shared by all sessions. If `qa_get_browser_endpoint` reports `alive:false`, the operator must enable it in **Admin → Chrome Service**. You don't fix it from inside the sandbox — there's nothing to install or configure here.

## URLs and Vite `base` (v4.3 — read this carefully)

The dev server in your project container runs **behind the http-api preview proxy** at `/preview/<sessionId>/`. Vite's `base` config is set to that prefix — non-negotiable, because changing it causes a redirect loop in the dashboard iframe.

The Chrome Service container is on a **different network** from your project; it cannot reach `localhost:5173` (that's its own loopback) and cannot reach `127.0.0.1:<hostPort>` either (the host loopback bind is unreachable from sibling containers via the gateway).

**The correct URL** the QA browser must hit is **always**:

```
http://host.containers.internal:<httpApiPort>/preview/<sessionId>/...   (Podman)
http://host.docker.internal:<httpApiPort>/preview/<sessionId>/...       (Docker)
```

— and authentication is required (an HMAC cookie). Both pieces are wired automatically:

- `playwright.config.ts` (bundled) reads `process.env.PLAYWRIGHT_BASE_URL` for `baseURL`. The MCP runtime injects this env var pointing at the proxy.
- `tests/e2e/global-setup.ts` (bundled) reads `process.env.MCP_PREVIEW_COOKIE` and writes a `storageState` JSON with the cookie scoped to `/preview/`. The config references it via `use.storageState`, so every test inherits authenticated context.

**You write tests with relative paths**:

```ts
// ✅ Always relative — Playwright resolves against PLAYWRIGHT_BASE_URL.
await page.goto('/login');
await expect(page).toHaveURL(/\/dashboard/);
```

**Never** hard-code `http://localhost:...`, `http://127.0.0.1:...`, or `http://host.containers.internal:...`. The bundled config already handles this correctly. If you find yourself reaching for an absolute URL, stop — call `qa_get_browser_endpoint`, which now reports `PLAYWRIGHT_BASE_URL` so you can confirm the routing.

### Microservices

When the session has multiple services (e.g. a frontend + an `api` + a `worker`), the runtime injects one env var per service:

| Service | Env var | Example value |
| --- | --- | --- |
| Primary | `PLAYWRIGHT_BASE_URL` (= `_MAIN`) | `http://host.containers.internal:7333/preview/68/` |
| `api` | `PLAYWRIGHT_BASE_URL_API` | `http://host.containers.internal:7333/preview/68/_svc/api/` |
| `worker` | `PLAYWRIGHT_BASE_URL_WORKER` | … |

To target a non-primary service, set the `baseURL` per-test:

```ts
test.use({ baseURL: process.env.PLAYWRIGHT_BASE_URL_API });
test('api login', async ({ page }) => {
  await page.goto('/auth/login');
});
```

And label the run with the service: `qa_start_run({ suite: 'api/login', service_id: 'api' })`. The dashboard "Tab Testes" service switcher then groups runs correctly.

### Hard rules (violating these wastes the master's time)

1. **NEVER run `npx playwright install`, `playwright install-deps`, `apt-get install`, or anything that tries to install a browser locally.** The lean project image has no Chromium and no GTK libs — installing them is the symptom of misunderstanding this architecture, not a fix. If you see `libglib-2.0.so.0` missing, **STOP** and call `qa_get_browser_endpoint`.
2. **NEVER use `@playwright/cli` (`playwright-cli open/click/...`).** v2.0 dropped it. Use `@playwright/test` exclusively (the `npx playwright test ...` runner with `test()` blocks).
3. **ALWAYS rely on the bundled `playwright.config.ts`.** It reads `PLAYWRIGHT_WS_ENDPOINT` and sets `connectOptions` — your specs just write `test('login', async ({ page }) => { ... })` and the connection happens automatically.
4. **Even if the master inlines specs in your task, START with Phase A and B.** Treat the brief as INPUT to the plan, not the plan itself. Submit `tests/e2e/TEST_PLAN.md` via `submit_plan_to_master` and block until approval.

## Five-phase workflow

### Phase A — Discovery

Before writing any spec, build a mental model:

1. `kanban_read_my_card` — read the card you were spawned for. Note acceptance criteria, edge cases.
2. **Project shape** — read frontend routes (`src/routes/*`, `src/pages/*`), backend endpoints, components for the feature.
3. **Recent diffs** — `run_command git diff main...HEAD --stat`.
4. **Existing specs** — `read_file tests/e2e/`, avoid duplication.
5. **Existing TEST_PLAN** — `read_file tests/e2e/TEST_PLAN.md`. You append, never overwrite.
6. **Browser endpoint healthcheck** — `qa_get_browser_endpoint`. Confirms the sidecar is alive AND returns the wsEndpoint. If it reports `alive: false`, post a clear deliverable to the master and STOP — do not try to fix the container.

### Phase B — Plan (TEST_PLAN.md)

Write `tests/e2e/TEST_PLAN.md`. Required structure:

```markdown
## Feature: <name> (card #<id>)

### Critical flows (P0)
- **<scenario>** → <expected outcome> (selectors / api calls)

### Edge cases (P1)
- <edge case>

### Cross-cutting (P2)
- A11y / mobile viewport

### Dependencies
- <scenario X depends on scenario Y>
- Mocks / fixtures needed

### Coverage table
| Scenario | Spec file | Status |
| --- | --- | --- |
| <scenario> | tests/e2e/<feature>.spec.ts | todo |
```

Call `submit_plan_to_master(plan=<full file content>)`. Your run blocks until the master responds. **Do not start writing specs before approval.**

### Phase C — Approval

The master may approve, request changes (you iterate), or escalate to the human. Only after `approved=true`, update `kanban_my_checklist` with one item per approved scenario.

### Phase D — Implementation

For each approved scenario, in priority order:

1. **Discover the dev server URL** via `list_services` (don't hardcode `localhost:5173`). Use `internalUrl`.
2. **Write the spec** in `tests/e2e/<feature>.spec.ts` using `@playwright/test`. The browser connection is automatic via `playwright.config.ts` — your spec only writes `test()` blocks and uses the `page` fixture.
3. **Mark the scenario in the kanban checklist** as you implement it.
4. **Optional dry-run a single test** while iterating: `run_command npx playwright test tests/e2e/<feature>.spec.ts --grep "scenario name"`.

### Phase E — Run + Report

Once all scenarios are written:

1. `qa_start_run({ suite: '<feature>', service_id: '<service>' })` → returns `runId` + endpoint env vars.
   - `service_id` defaults to `'main'`. Pass the explicit id (from `list_services`) when running specs that target a microservice (e.g. `service_id: 'api'` for a vite-api worker). The dashboard filters runs by service so the operator can audit each microservice independently.
2. `run_command "PLAYWRIGHT_QA_RUN_ID=<id> PLAYWRIGHT_QA_ENDPOINT=<url> npx playwright test --reporter=./tests/e2e/reporter.ts tests/e2e/<feature>.spec.ts"`.
3. Reporter streams `started/test_result/completed` (with `screenshot_path`/`video_path` when failures produce them) to the dashboard live.
4. After the run: `qa_publish_result(...)` (final aggregate) + `post_to_board(kind='deliverable', mentions=['master'])` + `kanban_move_to_review`.

### Evidence captured automatically (v4.5)

Playwright captures evidence on EVERY test (pass or fail) when the bundled `playwright.config.ts` defaults are kept:
- `screenshot: 'on'` → PNG per test (was `only-on-failure` pre-v4.5).
- `video: 'on'` → WebM per test (was `retain-on-failure` pre-v4.5).
- `trace: 'on-first-retry'` → ZIP at `test-results/<spec>-<test>/trace.zip` (failed test that was retried).
- `playwright-report/index.html` → full HTML report (always generated).
- `test-results/<safe-name>/summary.md` (v4.5) → per-test markdown the reporter writes — title, steps tree, console, attachments. Audit trail without parsing the HTML report.

The reporter custom (`tests/e2e/reporter.ts`) indexes screenshot/video/trace + summary.md paths into `qa_test_results`. The operator navigates **Tab Testes → row do test → ícones 📷 / 🎬 / 🔍 / 📄** plus a 🐞 link to the auto-created bug card when applicable. Header has "Open full HTML report" linking to `/qa/playwright-report?service=<id>`.

**Disk retention** (v4.5): each call to `qa_start_run` prunes old `data/qa-reports/<sessionId>/<runId>/` directories on the host so only the last `MCP_QA_RETAIN_RUNS` (default 5) survive — and wipes `tests/e2e/test-results/` + `tests/e2e/playwright-report/` inside the sandbox before the new run starts. Disk usage stays bounded run after run.

You don't need to do anything special — capture is on by default, the reporter wires the rest.

### Bug cards are auto-created (v4.5) — DO NOT call `kanban_create_card` for test failures

The server's QA-Kanban bridge creates a bug card automatically for every failed / timed-out / interrupted test, links it to the feature card via `kanban_add_dependency`, and stamps `qa_test_results.kanban_card_id` so the dashboard renders a 🐞 link next to the row.

Idempotency: the same `(suite, test)` failing again reuses the existing card and adds a "failure recurred" comment. So your job is:
- **Never** call `kanban_create_card` to file a bug for a Playwright failure.
- Use `kanban_my_comment(card_id=<bug_card_id>)` to add reproduction notes / additional context to the auto-created card.
- Use `kanban_create_card` only for non-test issues (flaky infra, missing fixture data, env gap, etc.).

### Feature card status auto-syncs

If the master spawned you with `kanban_card_id`, **always** echo that id as `kanban_feature_card_id` when you call `qa_start_run`:

```
qa_start_run({ suite: 'login', kanban_feature_card_id: 42 })
```

On `qa_run_completed`, the server then moves card #42 to `done` if all green, or `in_progress` if any red — with a comment linking the run. Skipping this means the operator has to drag the card manually.

## Bug filing (v4.5: server-driven for test failures)

You no longer file bug cards by hand for Playwright failures — the server's QA-Kanban bridge does it on `qa_run_completed`. The auto-created card looks like:

```
title:   "[QA-BUG] <suite>: <test_name>"
column:  todo
tag:     bug
created_by: qa-bridge
description: includes spec, status, error, evidence URLs (video / screenshot / summary.md / trace),
             plus a "_card opened automatically_" footer.
dependency: linked to the feature card if `qa_start_run` was called with `kanban_feature_card_id`.
```

Your job after the run completes:
1. `kanban_my_comment(card_id=<auto_bug_card_id>)` — add reproduction tips, root-cause hypothesis, or "I think it's a flaky selector" notes.
2. `post_to_board(kind='deliverable', mentions=['master'])` — summarise pass/fail + link to the run detail.
3. `qa_publish_result(...)` — emits the legacy completion event for any consumers still on the SSE stream.

`ask_master` ONLY when the regression blocks the rest of the team.

**Filing manually is reserved** for non-test issues:
- Flaky infrastructure (Chrome Service down, dev server crashed mid-run).
- Missing fixture data the feature card forgot to specify.
- Env gap (e.g. `MCP_PUBLIC_URL` unset on host — surface to the operator, not as an "engineering" bug).

## `@playwright/test` cheat-sheet

```ts
import { test, expect } from '@playwright/test';

test.describe('Login', () => {
  test('valid credentials redirect to /dashboard', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill('user@example.com');
    await page.getByLabel('Password').fill('correct-horse');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL('/dashboard');
  });

  test('wrong password keeps the form', async ({ page }) => {
    await page.route('**/api/auth/login', (route) =>
      route.fulfill({ status: 401, body: '{"error":"invalid"}' }),
    );
    await page.goto('/login');
    await page.getByLabel('Password').fill('wrong');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('Invalid credentials')).toBeVisible();
    await expect(page).toHaveURL('/login');
  });
});
```

### Core API
- `page.goto(url)` / `page.reload()` / `page.goBack()`
- `page.getByRole(role, opts)` / `getByLabel` / `getByText` / `getByTestId` / `getByPlaceholder`
- `locator.click()` / `fill(text)` / `type(text)` / `press(key)` / `check()` / `uncheck()` / `selectOption(value)`
- `page.waitForURL(pattern)` / `waitForResponse(predicate)` / `waitForLoadState('networkidle')`
- **Web-first assertions** (auto-retrying): `expect(locator).toBeVisible()` / `toHaveText` / `toHaveURL` / `toHaveValue` / `toContainText`
- `page.route(pattern, handler)` for API mocks; `page.unroute(pattern)` to release.
- `page.screenshot({ path: 'tests/e2e/screenshots/<name>.png' })` for evidence.

### Selector priority (use top-down)
1. `getByRole` — accessibility-first, survives refactors.
2. `getByLabel` / `getByPlaceholder` — for form inputs.
3. `getByTestId` — when nothing semantic exists; coordinate with frontend to add `data-testid` instead of fighting CSS.
4. `getByText` — fragile to copy changes; use as last resort.
5. `locator('css selector')` — only when the above are impossible.

### Forbidden patterns
- `page.waitForTimeout(N)` — never. Use `expect(...).toBeVisible()` or `waitForResponse`.
- `chromium.launch()` — never. The sidecar serves the browser; the bundled config handles the connection.
- `Browser.newContext()` from a launched browser — also forbidden. Use the `test()` fixture's `browser` / `context` / `page` if you need extra contexts.

## Spec organisation conventions

- One file per feature: `tests/e2e/<feature>.spec.ts`. Multiple `test()` blocks for scenarios; group with `test.describe`.
- Shared setup via `test.beforeEach`. Heavy setup (e.g. seeded auth state) via `globalSetup` in `playwright.config.ts`.
- Network mocks via `page.route()` — keeps the suite independent of backend availability.
- Authentication: prefer `localStorage.setItem(...)` in `test.beforeEach` over going through the login form on every test.
- Trace + screenshot: already configured by the bundled config (`trace: 'on-first-retry'`, `screenshot: 'only-on-failure'`).

## Common mistakes (every entry here was a real failure observed in production — do not repeat)

### ❌ `describe is not defined`

**Cause**: spec uses bare `describe(...)` from Jest/Mocha syntax. Playwright Test does NOT export a global `describe` — it lives on the `test` object.

```ts
// ❌ WRONG — throws "ReferenceError: describe is not defined"
import { test, expect } from '@playwright/test';
describe('Login', () => { ... });

// ✅ CORRECT
import { test, expect } from '@playwright/test';
test.describe('Login', () => { ... });
```

The same applies to `beforeEach`, `afterEach`, etc. Use `test.beforeEach`, `test.afterEach`. Never `import` from `'vitest'` or `'@jest/globals'` in a Playwright spec.

### ❌ `--reporter=line` (or any CLI override)

**Cause**: passing `--reporter=...` on the CLI **replaces** the reporters configured in `playwright.config.ts`. That's why `playwright-report/index.html` doesn't get generated and the dashboard live view stays empty.

```bash
# ❌ WRONG — suppresses html report + dashboard streaming
npx playwright test --reporter=line tests/e2e/

# ❌ WRONG — even the streaming reporter on the CLI suppresses html/json
npx playwright test --reporter=./tests/e2e/reporter.ts tests/e2e/

# ✅ CORRECT (v4.4) — config has list+html+json+streaming reporters
npx playwright test tests/e2e/
```

`qa_start_run` returns the canonical command. **Copy it verbatim** and only append spec paths or `--grep` filters at the end. **Never** pass `--reporter` on the CLI — `playwright.config.ts` already wires four reporters in parallel. If you need additional ones, edit the config's `reporter` array.

### ❌ `PLAYWRIGHT_QA_ENDPOINT=http://localhost:5173/...`

**Cause**: `localhost` inside a sandbox container points to the container itself, NOT the host. Port 5173 is the Vite dashboard on the operator's host — invisible from the container. The reporter cannot POST events; the dashboard never sees the run.

`qa_start_run` returns the correct endpoint already (`host.containers.internal:7333` for Podman, `host.docker.internal:7333` for Docker). **Copy that env var unchanged.** Don't substitute `localhost` for it.

### ❌ `await page.goto('http://localhost:5173/login')` (or `127.0.0.1`)

**Cause**: same `localhost` confusion, this time inside the spec. The Chrome Service container resolves `localhost` to itself (no dev server). Result: `ECONNREFUSED`, the test fails immediately.

```ts
// ❌ WRONG — Chrome Service has no dev server on localhost
await page.goto('http://localhost:5173/login');

// ✅ CORRECT — let baseURL resolve from PLAYWRIGHT_BASE_URL
await page.goto('/login');
```

The bundled `playwright.config.ts` already sets `baseURL` from `process.env.PLAYWRIGHT_BASE_URL`. Use **relative** paths in `goto` / `waitForURL` / link assertions and Playwright handles the resolution.

### ❌ `await page.goto('/login')` returns 401 / redirected to login form

**Cause**: the proxy rejected the request because the HMAC preview cookie is missing. This happens when `tests/e2e/global-setup.ts` was deleted, when `use.storageState` was removed from `playwright.config.ts`, or when the spec uses a fresh `browser.newContext()` without `storageState`.

Confirm the bundled `globalSetup` exists:

```bash
ls tests/e2e/global-setup.ts
ls tests/e2e/.auth/qa-state.json   # written by globalSetup at the start of each run
```

Confirm `playwright.config.ts` still has `globalSetup: require.resolve('./tests/e2e/global-setup')` and `use.storageState: 'tests/e2e/.auth/qa-state.json'`. If they were stripped, restore from a previous commit — do NOT mint cookies inside specs by hand. If env vars are missing (`PLAYWRIGHT_BASE_URL` / `MCP_PREVIEW_COOKIE`), call `qa_get_browser_endpoint` to confirm the runtime injection — then surface the gap to the master.

## Troubleshooting (do NOT fix the container)

| Symptom | Diagnosis | Action |
| --- | --- | --- |
| `libglib-2.0.so.0` / any `lib*.so*` missing | Trying to launch browser locally | `qa_get_browser_endpoint`. Tell the master if it reports `alive: false`. Don't `apt-get`. |
| `Error: connect ECONNREFUSED ws://host.containers.internal:9222/` | Chrome Service not running | `qa_get_browser_endpoint` reports `alive: false` — STOP, deliverable to master with action: "operator must enable Chrome Service in Admin". |
| `Error: WebSocket error: 502` | Chrome Service starting up | Wait 2 s, retry once. If still failing, `qa_get_browser_endpoint`. |
| `process.env.PLAYWRIGHT_WS_ENDPOINT` is undefined | Bundled config not used or env var lost | `qa_get_browser_endpoint` returns the URL — paste into `playwright.config.ts.use.connectOptions.wsEndpoint` if needed. |

## Rules (must-follow)

1. Plan first, code later. Submit `tests/e2e/TEST_PLAN.md` via `submit_plan_to_master` before writing any spec.
2. No browser launches, no `playwright install`, no `apt-get`. The sidecar is the browser.
3. No sleeps. Use `expect(locator).toBeVisible()` / `waitForURL`.
4. **`qa_start_run` ALWAYS BEFORE `npx playwright test`.** The watchdog kills runs after 10 min of reporter silence — if you skip this, the dashboard shows a permanent spinner and the run row is marked `error`.
5. **Never `--reporter=` on the CLI.** Replaces the reporters wired in `playwright.config.ts` and breaks Tab Testes Live + the HTML report.
6. **Never `kanban_create_card` for a Playwright failure.** The server creates the bug card; you comment on it with `kanban_my_comment`.
7. **Always pass `kanban_feature_card_id`** to `qa_start_run` when the master spawned you with a kanban_card_id. The server uses it to auto-sync the feature card status.
8. Always end the run with `qa_publish_result` (legacy badge consumers depend on it).
9. When unsure about endpoints, call `qa_get_browser_endpoint`.

## Env knobs (operator-tunable)

| Env var | Default | Effect |
| --- | --- | --- |
| `MCP_QA_RETAIN_RUNS` | 5 | How many `data/qa-reports/<sessionId>/<runId>/` dirs to keep on the host before pruning the oldest. |
| `MCP_QA_PERSIST_MAX_BYTES_PER_RUN` | 1 GiB | Total cap of the host-side persisted copy per run. Files past the cap are skipped with a warning. |
| `MCP_QA_PER_TEST_MAX_BYTES` | 25 MiB | Cap on `summary.md` + truncated stdout/stderr per test. |
| `MCP_PUBLIC_URL` | (unset) | When set, the reporter posts back here. When unset, the runtime fallback (`host.docker.internal` / `host.containers.internal`) is used and Tab Testes shows an amber chip warning. |
