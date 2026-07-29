/**
 * Static template for the custom Playwright reporter that the scaffold
 * writes into the sandbox at `tests/e2e/reporter.ts`.
 *
 * The reporter posts JSON to the http-api's `/api/company/sessions/:id/qa/test-event`
 * endpoint as the suite progresses, so the dashboard's LiveRunView can
 * update incrementally without parsing Playwright's stdout.
 *
 * Why a template string instead of a real `.ts` file copied at build
 * time: simpler — we already write `playwright.config.ts` from a
 * template renderer, this just adds another file alongside. No build
 * step changes required.
 *
 * The runtime needs:
 *   - `PLAYWRIGHT_QA_ENDPOINT` — full URL the reporter POSTs events to.
 *     Scaffolder injects this via `playwright-bootstrap.ts`.
 *   - `PLAYWRIGHT_QA_RUN_ID`   — UUID of the QA-run bundle entity created by
 *     the agent before invoking `npx playwright test`. Allows the
 *     endpoint to associate test events with the correct run.
 *
 * Both are passed through the env when the QA agent runs the suite:
 * `PLAYWRIGHT_QA_RUN_ID=42 PLAYWRIGHT_QA_ENDPOINT=http://... npx playwright test`.
 *
 * Pure module — exports only the rendered string. Tests snapshot the
 * output to keep the contract with the endpoint stable.
 */
export const REPORTER_TEMPLATE = `// ────────────────────────────────────────────────────────────
// MCP-managed file — DO NOT EDIT.
// This reporter is rewritten on every sandbox provision. Any local
// edits will be lost. The file is also force-restored when the QA
// agent calls \`qa_start_run\` (v4.4) so accidental clobbering by a
// subordinate is auto-recovered before the next run.
//
// What it does:
//   - Streams Playwright reporter events to the http-api so the
//     dashboard's TestsTab can render the run live.
//   - Writes a per-test markdown summary to
//     \`test-results/<safe-name>/summary.md\` (v4.5) for an audit
//     trail that survives without parsing the HTML report.
//   - Buffers events with exponential-backoff retry so transient
//     network blips on the host don't lose data — onEnd flushes the
//     queue inside a 5 s budget before Playwright kills the process.
//
// Run config source (priority order, v4.4):
//   1. tests/e2e/.mcp-qa-run.json — written by qa_start_run; primary.
//   2. PLAYWRIGHT_QA_RUN_ID + PLAYWRIGHT_QA_ENDPOINT env vars — fallback
//      for legacy / manual invocations.
// When neither is present we LOG TO STDERR (so the agent sees it) and
// degrade to a no-op so the suite still runs locally.
// ────────────────────────────────────────────────────────────
import type { Reporter, TestCase, TestResult, FullResult, Suite } from '@playwright/test/reporter';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface RunConfig {
  runId: string;
  endpoint: string;
}

function loadRunConfig(): RunConfig | null {
  // 1) JSON file at tests/e2e/.mcp-qa-run.json (workspace-rel).
  try {
    const p = path.resolve('tests/e2e/.mcp-qa-run.json');
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (raw && typeof raw.runId === 'string' && typeof raw.endpoint === 'string') {
        return { runId: raw.runId, endpoint: raw.endpoint };
      }
    }
  } catch {
    // fall through to env
  }
  // 2) Env vars (legacy).
  const envEndpoint = process.env.PLAYWRIGHT_QA_ENDPOINT;
  const envRunId = process.env.PLAYWRIGHT_QA_RUN_ID;
  if (envEndpoint && envRunId) {
    return { runId: envRunId, endpoint: envEndpoint };
  }
  return null;
}

const RUN_CONFIG = loadRunConfig();
if (!RUN_CONFIG) {
  // Loud stderr so the agent sees the gap in run_command output. Without
  // this the reporter would silently no-op and the operator would think
  // the dashboard is broken when in fact qa_start_run was never called.
  // eslint-disable-next-line no-console
  console.error(
    '[qa-reporter] No run config found. Expected tests/e2e/.mcp-qa-run.json (written by qa_start_run) ' +
    'OR env vars PLAYWRIGHT_QA_RUN_ID + PLAYWRIGHT_QA_ENDPOINT. ' +
    'Events will NOT reach the dashboard. Did you call qa_start_run before running the suite?',
  );
}

const ENDPOINT = RUN_CONFIG?.endpoint ?? '';
const RUN_ID = RUN_CONFIG?.runId ?? '';

// v4.5 — per-test markdown size cap. Truncates stdout/stderr so a noisy
// console doesn't blow up the disk. Override via env if needed.
const PER_TEST_MAX_BYTES = (() => {
  const raw = process.env.MCP_QA_PER_TEST_MAX_BYTES;
  if (!raw) return 25 * 1024 * 1024;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 25 * 1024 * 1024;
})();

interface BeginEvent {
  kind: 'started';
  runId: string;
  count: number;
}
interface TestResultEvent {
  kind: 'test_result';
  runId: string;
  spec: string;
  name: string;
  status: 'passed' | 'failed' | 'skipped' | 'timed-out' | 'interrupted';
  duration_ms: number;
  error: string | null;
  trace_path: string | null;
  screenshot_path: string | null;
  video_path: string | null;
  /** v4.5 — workspace-relative path to the per-test markdown summary. */
  summary_md_path: string | null;
}
interface EndEvent {
  kind: 'completed';
  runId: string;
  passed: number;
  failed: number;
  skipped: number;
  duration_ms: number;
  /** v4.5 — events the buffer dropped after exhausting retries. */
  dropped_events?: number;
}

type Event = BeginEvent | TestResultEvent | EndEvent;

// ── Retry queue (v4.5) ────────────────────────────────────────────
//
// Each event has its own attempt counter. We try to POST immediately;
// on failure we re-enqueue with an increasing delay. \`onEnd\` flushes
// inside a 5 s budget so a stuck dashboard doesn't keep the test
// process alive past the suite's natural end.

interface QueueEntry {
  event: Event;
  attempts: number;
  /** ms epoch — earliest time this entry should be retried. */
  nextAt: number;
}

const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
const MAX_QUEUE = 500;
const queue: QueueEntry[] = [];
let dropped = 0;

async function postOnce(event: Event): Promise<boolean> {
  if (!ENDPOINT || !RUN_ID) return true; // local-only — pretend success
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function enqueue(event: Event): void {
  if (queue.length >= MAX_QUEUE) {
    dropped++;
    return;
  }
  queue.push({ event, attempts: 0, nextAt: Date.now() });
}

async function drainQueue(deadlineMs: number): Promise<void> {
  while (queue.length > 0 && Date.now() < deadlineMs) {
    const entry = queue[0];
    if (entry.nextAt > Date.now()) {
      const wait = Math.min(entry.nextAt - Date.now(), deadlineMs - Date.now());
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    if (Date.now() >= deadlineMs) break;
    const ok = await postOnce(entry.event);
    if (ok) {
      queue.shift();
      continue;
    }
    entry.attempts++;
    if (entry.attempts >= BACKOFF_MS.length) {
      queue.shift();
      dropped++;
      continue;
    }
    entry.nextAt = Date.now() + BACKOFF_MS[entry.attempts];
  }
  // Anything left when the deadline fires is counted as dropped so the
  // operator sees the partial-data warning on the dashboard.
  dropped += queue.length;
  queue.length = 0;
}

/** Fire-and-forget: try once, enqueue on failure. Pure-ish — the queue is module-scoped. */
function emit(event: Event): void {
  void postOnce(event).then((ok) => {
    if (!ok) enqueue(event);
  });
}

// ── Per-test markdown summary (v4.5) ─────────────────────────────

function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'test';
}

function truncate(s: string | undefined, max: number): string {
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, max) + \`\\n…(truncated, original \${s.length} bytes)\`;
}

function renderTestSummary(
  test: TestCase,
  result: TestResult,
  status: TestResultEvent['status'],
): string {
  const lines: string[] = [];
  lines.push(\`# \${test.titlePath().slice(1).join(' > ') || test.title}\`);
  lines.push('');
  lines.push(\`- **Status**: \${status}\`);
  lines.push(\`- **Duration**: \${result.duration} ms\`);
  lines.push(\`- **Spec**: \\\`\${test.location.file}:\${test.location.line}\\\`\`);
  lines.push(\`- **Retry**: \${result.retry}\`);
  lines.push('');
  if (result.error) {
    lines.push('## Error');
    lines.push('\`\`\`');
    lines.push(truncate(result.error.message, 4_000));
    if (result.error.stack) {
      lines.push('');
      lines.push(truncate(result.error.stack, 4_000));
    }
    lines.push('\`\`\`');
    lines.push('');
  }
  if (Array.isArray(result.steps) && result.steps.length > 0) {
    lines.push('## Steps');
    for (const step of result.steps) {
      const dur = typeof step.duration === 'number' ? \` (\${step.duration} ms)\` : '';
      const err = step.error ? ' ❌' : '';
      lines.push(\`- \${step.title}\${dur}\${err}\`);
    }
    lines.push('');
  }
  const stdout = result.stdout?.map((c) => (typeof c === 'string' ? c : c.toString('utf8'))).join('') ?? '';
  if (stdout) {
    lines.push('## stdout');
    lines.push('\`\`\`');
    lines.push(truncate(stdout, Math.floor(PER_TEST_MAX_BYTES / 4)));
    lines.push('\`\`\`');
    lines.push('');
  }
  const stderr = result.stderr?.map((c) => (typeof c === 'string' ? c : c.toString('utf8'))).join('') ?? '';
  if (stderr) {
    lines.push('## stderr');
    lines.push('\`\`\`');
    lines.push(truncate(stderr, Math.floor(PER_TEST_MAX_BYTES / 4)));
    lines.push('\`\`\`');
    lines.push('');
  }
  if (Array.isArray(result.attachments) && result.attachments.length > 0) {
    lines.push('## Attachments');
    for (const a of result.attachments) {
      lines.push(\`- \\\`\${a.name}\\\` (\${a.contentType ?? 'unknown'}) — \\\`\${a.path ?? '(no path)'}\\\`\`);
    }
    lines.push('');
  }
  return lines.join('\\n');
}

function writeSummaryMarkdown(test: TestCase, result: TestResult, status: TestResultEvent['status']): string | null {
  try {
    const dir = path.resolve('test-results', safeName(test.titlePath().join(' ')));
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'summary.md');
    const content = renderTestSummary(test, result, status);
    fs.writeFileSync(target, content);
    // Return workspace-relative — the artifact route resolves these.
    return path.relative(process.cwd(), target).replace(/\\\\/g, '/');
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[qa-reporter] writeSummaryMarkdown failed:', (e as Error).message);
    return null;
  }
}

export default class StreamReporter implements Reporter {
  private startMs = 0;
  private passed = 0;
  private failed = 0;
  private skipped = 0;

  onBegin(_config: unknown, suite: Suite): void {
    this.startMs = Date.now();
    emit({ kind: 'started', runId: RUN_ID, count: suite.allTests().length });
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const status: TestResultEvent['status'] = mapStatus(result.status);
    if (status === 'passed') this.passed++;
    else if (status === 'skipped') this.skipped++;
    else this.failed++;

    const summary_md_path = writeSummaryMarkdown(test, result, status);

    // Playwright populates result.attachments with { name, path,
    // contentType }. The well-known names are: 'trace', 'screenshot',
    // 'video'. We index all three so the dashboard can render the
    // gallery + offer the trace viewer.
    const att = result.attachments;
    emit({
      kind: 'test_result',
      runId: RUN_ID,
      spec: test.location.file,
      name: test.titlePath().slice(1).join(' > ') || test.title,
      status,
      duration_ms: result.duration,
      error: result.error?.message ?? null,
      trace_path: att.find((a) => a.name === 'trace')?.path ?? null,
      screenshot_path: att.find((a) => a.name === 'screenshot')?.path ?? null,
      video_path: att.find((a) => a.name === 'video')?.path ?? null,
      summary_md_path,
    });
  }

  async onEnd(_result: FullResult): Promise<void> {
    // Flush queued retries for previous events first (5 s budget).
    await drainQueue(Date.now() + 5_000);
    const completed: EndEvent = {
      kind: 'completed',
      runId: RUN_ID,
      passed: this.passed,
      failed: this.failed,
      skipped: this.skipped,
      duration_ms: Date.now() - this.startMs,
    };
    if (dropped > 0) completed.dropped_events = dropped;
    // Final post inline so the run is marked completed before the
    // process exits. If this fails, we accept it — the watchdog will
    // mark the row as errored 10 min later.
    const ok = await postOnce(completed);
    if (!ok) {
      // eslint-disable-next-line no-console
      console.warn('[qa-reporter] final completed POST failed; watchdog will eventually flag the run.');
    }
  }
}

function mapStatus(status: TestResult['status']): TestResultEvent['status'] {
  switch (status) {
    case 'passed':
      return 'passed';
    case 'failed':
      return 'failed';
    case 'skipped':
      return 'skipped';
    case 'timedOut':
      return 'timed-out';
    case 'interrupted':
      return 'interrupted';
    default:
      return 'failed';
  }
}
`;
