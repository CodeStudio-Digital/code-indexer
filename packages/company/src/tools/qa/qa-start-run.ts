/**
 * Tool: `qa_start_run`. Called by a QA subordinate **before** invoking
 * `npx playwright test ...`. It:
 *
 *   1. Creates an independent QA-run JSON entity in `running` state (via the
 *      injected `IQaTestRunStore`).
 *   2. Returns the new `run_id` plus the env vars (`PLAYWRIGHT_QA_RUN_ID`,
 *      `PLAYWRIGHT_QA_ENDPOINT`) the agent must export so the bundled
 *      Playwright reporter (`tests/e2e/reporter.ts`) can stream events
 *      back to `/api/company/sessions/:id/qa/test-event`.
 *
 * The endpoint URL is resolved from `MCP_PUBLIC_URL` (or its fallback
 * `MCP_DASHBOARD_URL`) so that a container — which does not share the
 * host's loopback — can reach the http-api. When neither is set we
 * emit `http://host.docker.internal:7333` (Docker Desktop convention)
 * and return a clear message explaining the assumption so the agent
 * can override via env if it doesn't apply.
 *
 * The store is injected at boot via `setQaTestRunStore` (mirrors the
 * env-tools pattern) — keeps `companyContext` free of QA-specific
 * dependencies.
 */
import type { CoderTool } from "@mcp/code-agent/core/tool.js";
import type { JsonSchema } from "@mcp/provider-sdk";
import { ok, err } from "@mcp/agent-runtime-host/tool-result.js";
import type { CompanyOrchestrator } from '@mcp/company/orchestrator.js';
import type { IQaTestRunStore } from '@mcp/services/qa/store/interfaces.js';
import type { QaRunTrigger } from '@mcp/services/qa/types.js';
import { assertUuid } from '@mcp/session-storage';
import { getResolvedRuntime, getSandboxManager } from '@mcp/services/sandbox/index.js';
import {
  restoreQaWorkspace,
  type WorkspaceRestoreReport,
} from '@mcp/services/qa/workspace-restore.js';
import {
  validateQaRunConfig,
  type QaConfigValidation,
} from '@mcp/services/qa/config-validator.js';
import { resolvePlanGate, roleHasQaPlaywrightSkill } from './qa-plan-gate.js';
import { preflightBrowser } from './qa-preflight.js';

// Re-export for back-compat with existing tests / external callers.
export type { WorkspaceRestoreReport };

// ─── Module-level store binding (injected at boot) ──────────────

let runStore: IQaTestRunStore | null = null;

/**
 * Wire the QaTestRunStore from `server.ts`. Called once during boot.
 * Pass `null` only in tests that want to verify the absent-store path.
 */
export function setQaTestRunStore(store: IQaTestRunStore | null): void {
  runStore = store;
}

// ─── Helpers (pure, exported for tests) ─────────────────────────

const VALID_TRIGGERS: ReadonlySet<QaRunTrigger> = new Set(['agent', 'human', 'watcher']);

/**
 * Container-runtime-aware host hostnames for the loopback equivalent.
 * - Docker Desktop (mac/win): `host.docker.internal`
 * - Podman (4.0+):            `host.containers.internal`
 * - Linux Docker w/o Desktop: usually requires explicit MCP_PUBLIC_URL
 *
 * Both names resolve to the host gateway from inside the container.
 * We pick based on `MCP_CONTAINER_RUNTIME` (set by the operator) or
 * fall back to the docker name — a docker-only smoke still works on
 * rare misconfigurations because most runtimes also accept
 * `host.docker.internal` via DNS aliasing nowadays.
 */
const FALLBACK_BY_RUNTIME: Record<string, string> = {
  docker: 'http://host.docker.internal:7333',
  podman: 'http://host.containers.internal:7333',
};
const DEFAULT_FALLBACK = FALLBACK_BY_RUNTIME.docker;

export interface ResolvedEndpoint {
  base: string;
  /** True when we used the runtime fallback because no MCP_PUBLIC_URL was set. */
  fallback: boolean;
}

/**
 * Resolve the URL the QA reporter (running INSIDE the sandbox) should
 * POST events to. Pure: takes the env explicitly + an optional runtime
 * hint so tests don't have to mutate `process.env` or boot a driver.
 *
 * Precedence:
 *  1. `MCP_PUBLIC_URL`        → operator-supplied absolute URL.
 *  2. `MCP_DASHBOARD_URL`     → legacy alias.
 *  3. `runtimeHint` argument  → set by the caller from the resolved
 *                                driver (preferred when available).
 *  4. `MCP_SANDBOX_RUNTIME`   → matches `driver-factory` env var.
 *  5. Hardcoded docker default.
 */
export function resolveEndpointBase(
  env: NodeJS.ProcessEnv = process.env,
  runtimeHint?: string | null,
): ResolvedEndpoint {
  const raw = env.MCP_PUBLIC_URL ?? env.MCP_DASHBOARD_URL ?? '';
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (trimmed) return { base: trimmed, fallback: false };
  const runtime = (runtimeHint ?? env.MCP_SANDBOX_RUNTIME ?? '').toLowerCase().trim();
  const base = FALLBACK_BY_RUNTIME[runtime] ?? DEFAULT_FALLBACK;
  return { base, fallback: true };
}

export function buildEndpointPath(sessionId: string): string {
  return `/api/company/sessions/${sessionId}/qa/test-event`;
}

// Re-export so existing tests keep importing `renderRunConfigFile`
// from this module after the helper migrated to `workspace-restore.ts`.
export { renderRunConfigFile } from '@mcp/services/qa/workspace-restore.js';

export function normaliseTrigger(raw: unknown): QaRunTrigger {
  if (typeof raw === 'string' && VALID_TRIGGERS.has(raw as QaRunTrigger)) {
    return raw as QaRunTrigger;
  }
  return 'agent';
}

// ─── Tool definition ────────────────────────────────────────────

const PARAMETERS: JsonSchema = {
  type: 'object',
  properties: {
    suite: {
      type: 'string',
      description:
        'Suite identifier (typically the spec file or feature, e.g. "login" or "tests/e2e/login.spec.ts").',
    },
    trigger: {
      type: 'string',
      enum: ['agent', 'human', 'watcher'],
      description:
        'Who/what kicked off the run (default "agent"). The dashboard surfaces this in the runs table.',
    },
    service_id: {
      type: 'string',
      description:
        'Optional microservice id this run targets (default "main"). Use the service_id from `list_services` when running specs against a sibling container — the dashboard\'s Tab Testes filters by this so the operator can audit QA per service.',
    },
    kanban_feature_card_id: {
      type: 'string',
      description:
        'Optional id of the "QA: <feature>" Kanban card this run is auditing. When set, the server-side bridge auto-moves that card on completion: `done` if all green, `in_progress` if any red. Use the id of the kanban card you were spawned for (`kanban_read_my_card` returns it).',
    },
  },
  required: ['suite'],
};

/**
 * Pure: validate + normalise the optional `kanban_feature_card_id` arg.
 * Returns null when omitted; throws when present but not a positive
 * integer so the agent gets a clear error instead of silently losing
 * the linkage on a typo.
 */
export function normaliseFeatureCardId(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string') {
    return assertUuid(raw, 'kanban_feature_card_id');
  }
  throw new Error(
    `Invalid kanban_feature_card_id ${JSON.stringify(raw)} — must be a UUID.`,
  );
}

/** Pure: validate + normalise the optional service_id arg. */
export function normaliseServiceId(raw: unknown): string {
  if (typeof raw !== 'string') return 'main';
  const trimmed = raw.trim();
  if (trimmed === '') return 'main';
  // service_id schema mirrors `provisionAdditionalService` validation:
  // lowercase letters/digits/hyphen, 1-32 chars, must start with a letter.
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(trimmed)) {
    throw new Error(
      `Invalid service_id "${trimmed}" — use lowercase letters, digits, hyphen; 1-32 chars; must start with a letter.`,
    );
  }
  return trimmed;
}

/**
 * Pure: render the config-invalid refusal (B7). No row exists at this
 * point, so the `error_class` rides the message for the agent/operator.
 */
export function formatConfigRefusal(v: QaConfigValidation): string {
  const lines = [
    'qa_start_run refused (error_class=config_invalid): playwright.config.ts breaks the QA contract:',
    ...v.problems.map((p) => `  • ${p}`),
  ];
  if (v.suggestion) lines.push(`Suggestion: ${v.suggestion}`);
  return lines.join('\n');
}

export function qaStartRun(
  orchestrator: CompanyOrchestrator,
  agentRole: string,
  agentRunId: string | null,
): CoderTool {
  return {
    name: 'qa_start_run',
    description:
      'Create a QA test run record and obtain the env vars (PLAYWRIGHT_QA_RUN_ID, PLAYWRIGHT_QA_ENDPOINT) the bundled Playwright reporter needs. Call this BEFORE `npx playwright test`. QA subordinates must have an APPROVED plan first (submit_plan_to_master) — the tool refuses otherwise.',
    parameters: PARAMETERS,
    source: 'native',
    handler: async (args) => {
      try {
        const store = runStore;
        if (!store) {
          return err(
            'qa_start_run: QaTestRunStore not wired. Restart the server — this is a boot-time configuration bug.',
          );
        }
        const suite = mustString(args.suite, 'suite');
        const trigger = normaliseTrigger(args.trigger);
        const service_id = normaliseServiceId(args.service_id);
        const sessionId = orchestrator.companySessionId;
        const kanban_feature_card_id = normaliseFeatureCardId(args.kanban_feature_card_id);

        // ── B7 gate 1: approved plan (enforcement, no new tool) ──
        const isQaSubordinate =
          agentRunId != null &&
          roleHasQaPlaywrightSkill(orchestrator.getSessionConfigJson(), agentRole);
        const gate = resolvePlanGate({
          requirePlanEnv: process.env.MCP_QA_REQUIRE_PLAN,
          isQaSubordinate,
          approval: agentRunId != null ? orchestrator.hasApprovedPlan(agentRunId) : null,
        });
        if (!gate.allowed) return err(gate.reason);

        const manager = getSandboxManager();

        // ── B7 gate 2: config contract (refuse BEFORE creating a row) ──
        // A missing/unreadable config is NOT a refusal — fresh scaffolds
        // are healed by restoreQaWorkspace below.
        let configContent: string | null = null;
        try {
          configContent = await manager.readWorkspaceFile(String(sessionId), 'playwright.config.ts');
        } catch {
          configContent = null;
        }
        if (configContent) {
          const verdict = validateQaRunConfig(configContent);
          if (!verdict.ok) return err(formatConfigRefusal(verdict));
        }

        // ── B7 gate 3: browser preflight (retry + breaker; no orphan row) ──
        const preflight = await preflightBrowser({ sessionId });
        if (!preflight.ok) {
          return err(`qa_start_run refused (error_class=sidecar_down): ${preflight.message}`);
        }

        const run = await store.startRun({
          company_session_id: sessionId,
          agent_run_id: agentRunId,
          suite,
          trigger,
          service_id,
          kanban_feature_card_id,
          plan_gate: gate.plan_gate,
        });

        const { base, fallback } = resolveEndpointBase(process.env, getResolvedRuntime());
        const endpoint = `${base}${buildEndpointPath(sessionId)}`;

        // ── v4.4: prepare the workspace so the reporter Just Works ──
        // Delegated to `restoreQaWorkspace` — same helper backs the
        // operator's "Restore QA config" button on Tab Testes.
        const restoreReport = await restoreQaWorkspace(manager, {
          sessionId,
          runConfig: { runId: run.id, endpoint },
        });

        const note = fallback
          ? '\n\nNote: MCP_PUBLIC_URL was not set on the host, so the endpoint uses host.docker.internal / host.containers.internal (runtime default). If the container cannot resolve that name, set MCP_PUBLIC_URL on the server and re-run.'
          : '';

        return ok(formatStartRunReply(run, endpoint, restoreReport, note));
      } catch (e) {
        return err(`qa_start_run failed: ${(e as Error).message}`);
      }
    },
  };
}

function mustString(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`${field} must be a non-empty string`);
  }
  return v;
}

// ─── v4.4: reply formatting ─────────────

/**
 * Pure: render the LLM-facing reply. Centralises the message so tests
 * can snapshot the exact wording the agent sees. The shape is:
 *
 *   1. Run header (id + suite + service).
 *   2. Optional restore status (✓/⚠) — only printed when something
 *      noteworthy happened, to keep the happy path concise.
 *   3. Canonical command — copy verbatim.
 *   4. Spec syntax + reporter footnotes.
 *   5. Optional fallback note (when MCP_PUBLIC_URL is missing).
 */
export function formatStartRunReply(
  run: { id: string; suite: string; service_id: string },
  endpoint: string,
  report: WorkspaceRestoreReport,
  note: string,
): string {
  const lines: string[] = [
    `Started qa_test_run id=${run.id} for suite "${run.suite}" (service=${run.service_id}).`,
  ];

  // Workspace restore section — only emit when we touched something
  // meaningful or there's a warning. Keep it short on the happy path.
  const restoreLines: string[] = [];
  if (report.runConfigWritten) {
    restoreLines.push(
      `  ✓ Wrote tests/e2e/.mcp-qa-run.json (run=${run.id}, endpoint=${endpoint}).`,
    );
  }
  if (report.reporterRestored) {
    restoreLines.push('  ✓ Restored tests/e2e/reporter.ts (MCP-managed).');
  }
  if (report.globalSetupRestored) {
    restoreLines.push('  ✓ Restored tests/e2e/global-setup.ts (HMAC cookie injection).');
  }
  if (report.configMissing.length > 0) {
    restoreLines.push(
      `  ⚠ playwright.config.ts is MISSING critical keys: ${report.configMissing.join(', ')}.`,
    );
    if (report.configRecommendedWritten) {
      restoreLines.push(
        '    Wrote playwright.config.recommended.ts next to it — diff and restore the missing parts before running.',
      );
    }
  }
  if (report.configRecommendations.length > 0) {
    restoreLines.push('  ℹ playwright.config.ts recommendations (non-critical):');
    for (const rec of report.configRecommendations) {
      restoreLines.push(`    • ${rec}`);
    }
  }
  if (report.prunedRunDirs.length > 0) {
    restoreLines.push(
      `  ✓ Pruned ${report.prunedRunDirs.length} old host run dir(s) (retention policy).`,
    );
  }
  if (report.wipedSandboxDirs.length > 0) {
    restoreLines.push(
      `  ✓ Wiped sandbox dirs: ${report.wipedSandboxDirs.join(', ')}.`,
    );
  }
  for (const w of report.warnings) {
    restoreLines.push(`  ⚠ ${w}`);
  }
  if (restoreLines.length > 0) {
    lines.push('');
    lines.push('Workspace restore:');
    lines.push(...restoreLines);
  }

  lines.push('');
  lines.push('COMMAND TO RUN — copy verbatim. The reporter is wired in playwright.config.ts;');
  lines.push('do NOT pass --reporter on the CLI (that suppresses dashboard streaming + HTML report).');
  lines.push('');
  lines.push('  npx playwright test');
  lines.push('');
  lines.push('You may APPEND a spec path filter (e.g. ` tests/e2e/login.spec.ts`)');
  lines.push('or `--grep "<pattern>"` to narrow which tests run.');
  lines.push('');
  lines.push('Spec syntax reminder: import `{ test, expect }` from `@playwright/test`');
  lines.push('and use `test.describe(...)` (NOT bare `describe(...)`, which is Jest /');
  lines.push('Mocha syntax and throws `ReferenceError: describe is not defined`).');
  if (note) lines.push(note);
  return lines.join('\n');
}
