#!/usr/bin/env tsx
/**
 * LOC cap enforcement — fails CI when a source file exceeds the soft
 * (≤300) or hard (≤500) limits documented in the cross-cutting
 * principles section of the company-mode plan.
 *
 * Scope:
 *   - `packages/{services,company,company-contracts,store,shared,indexer,code-agent,design-system}/src/**\/*.{ts,tsx}`
 *   - `apps/{http-api,dashboard,cli}/**\/*.{ts,tsx}`
 *   - Test files (`*.test.ts`, `__tests__/`) and seeds are excluded.
 *
 * Two levels:
 *   - HARD (>500 LOC) — fails the script with exit 1.
 *   - WARN (>300 LOC) — printed but exit 0.
 *
 * Allowlist `LOC_ALLOWLIST` carries the few files that legitimately
 * exceed the cap (state machines with unavoidable boilerplate, schema
 * snapshots, etc.). Adding to it should be a deliberate PR review item.
 *
 * Usage:
 *   npx tsx scripts/check-loc-cap.ts          # informational + exits 1 on hard violations
 *   npx tsx scripts/check-loc-cap.ts --strict # warns are also failures
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const REPO_ROOT = process.cwd();
const SOFT_CAP = 300;
const HARD_CAP = 500;

const ROOTS = [
  'packages/services/src',
  'packages/company/src',
  'packages/company-contracts/src',
  'packages/store/src',
  'packages/shared/src',
  'packages/indexer/src',
  'packages/code-agent/src',
  'packages/design-system/src',
  'apps/http-api',
  'apps/dashboard',
  'apps/cli',
];

const EXCLUDE_DIRS = new Set([
  'node_modules',
  'dist',
  '__tests__',
  'tests',
  '__snapshots__',
  '.next',
  'data',
]);

const EXCLUDE_FILE_PATTERNS: RegExp[] = [
  /\.test\.tsx?$/i,
  /\.spec\.tsx?$/i,
  /\.d\.ts$/,
  /\bseed[s]?\b.*\.ts$/i, // stack-seeds, fixture seeds
  /\bsnapshot.*\.ts$/i,
];

/**
 * Files we knowingly leave over the hard cap. Each entry needs a one-
 * line rationale so a future reviewer can decide whether it still
 * deserves the exception.
 */
const LOC_ALLOWLIST: Record<string, string> = {
  // Sandbox-manager coordinator after 19 sub-module extractions. The
  // boilerplate (constructor + driver getters/setters + deps bundlers)
  // is the irreducible coordinator shape.
  'packages/services/src/sandbox/sandbox-manager.ts':
    'Coordinator for 19 manager/ submodules; boilerplate + deps bundlers.',
  // Master state machine + bus-emit wrappers; further split would
  // scatter the state surface across multiple files for marginal gain.
  'packages/company/src/services/MasterLifecycle.ts':
    'State machine + bus-emit wrappers; further split scatters state.',
  // CompanyOrchestrator constructor wires every service slot — its
  // entire job is composition. Body decomposition would mostly move
  // wiring around without value.
  'packages/company/src/orchestrator.ts':
    'Composition root for company services; body is mostly slot wiring.',
  // Migration registry grows exactly 2 lines per migration by convention
  // (import + MIGRATIONS entry). Splitting it would break the single
  // ordered lineage the runner depends on.
  'packages/store/src/migrations/index.ts':
    'Migration registry; grows 2 lines per migration, single ordered lineage.',
};

/**
 * Grandfathered hard-cap violations — files that already exceeded 500 LOC when the
 * ratchet was turned on. They are accepted AS-IS so CI is green, while the hard cap
 * still BLOCKS any NEW file over 500 (no regression). The intent is to chip away at
 * this list with a decomposition backlog over time; prefer splitting new code over
 * adding entries here. Regenerate after a split:
 *   pnpm check:loc            # the ❌ list is the candidates to (re)grandfather
 */
const GRANDFATHERED: ReadonlySet<string> = new Set([
  'apps/dashboard/features/admin/PipelineBindingsPanel.tsx',
  'apps/dashboard/features/admin/SupervisorPanel.tsx',
  'apps/dashboard/features/agents/AgentsTab.tsx',
  'apps/dashboard/features/agents/CompanySessionView.tsx',
  'apps/dashboard/features/agents/DrivePanel.tsx',
  'apps/dashboard/features/agents/pipelines/NodeEditPanel.tsx',
  'apps/dashboard/features/agents/pipelines/PipelineBuilder.tsx',
  'apps/dashboard/features/chat/AgentChat.tsx',
  'apps/dashboard/features/chat/composer/Composer.tsx',
  'apps/dashboard/features/chat/messages/MessageList.tsx',
  'apps/dashboard/features/chat/messages/MessageView.tsx',
  'apps/dashboard/features/chat/SessionMetricsModal.tsx',
  'apps/dashboard/features/chat/SessionSidebar.tsx',
  'apps/dashboard/features/db-client/tree/ConnectionTree.tsx',
  'apps/dashboard/features/db-client/useDbClient.ts',
  'apps/dashboard/features/docs/AddSourceDialog.tsx',
  'apps/dashboard/features/docs/docs-api.ts',
  'apps/dashboard/features/ssh/SshPanel.tsx',
  'apps/dashboard/features/ssh/vault/use-ssh-vault-sync.ts',
  'apps/dashboard/features/telemetry/TelemetryDashboard.tsx',
  'apps/dashboard/features/workspace/EditorTabBar.tsx',
  'apps/dashboard/hooks/agent-stream/handlers.ts',
  'apps/dashboard/hooks/agent-stream/types.ts',
  'apps/dashboard/hooks/useCompanyStream.ts',
  'apps/dashboard/lib/perf/route-startup-metrics.ts',
  'apps/dashboard/state/workspace.ts',
  'apps/http-api/server.ts',
  'apps/http-api/server/deps.ts',
  'apps/http-api/server/routes/coder/interaction.ts',
  'apps/http-api/server/routes/coder/sessions.ts',
  'apps/http-api/server/routes/coder/stream.ts',
  'apps/http-api/server/routes/company/sessions.ts',
  'apps/http-api/server/routes/company/stream.ts',
  'apps/http-api/server/routes/docs/index.ts',
  'apps/http-api/sse/CoderWorkerPool.ts',
  'apps/http-api/sse/WorkerOrchestratorPool.ts',
  'apps/http-api/workers/coder-worker.ts',
  'apps/http-api/workers/company-worker.ts',
  'packages/code-agent/src/core/runner.ts',
  'packages/code-agent/src/core/runner/events.ts',
  'packages/code-agent/src/core/runner/machine/types.ts',
  'packages/code-agent/src/core/runner/nodes/executing.ts',
  'packages/code-agent/src/core/runner/nodes/executing-dispatch.ts',
  'packages/code-agent/src/core/smart-reducers.ts',
  'packages/code-agent/src/core/system-prompt.ts',
  'packages/code-agent/src/index.ts',
  'packages/code-agent/src/lsp/ts-service.ts',
  'packages/code-agent/src/pipelines/ChatPipelineExecutor.ts',
  'packages/code-agent/src/providers/anthropic.ts',
  'packages/code-agent/src/providers/capabilities.ts',
  'packages/code-agent/src/providers/chatgpt.ts',
  'packages/code-agent/src/providers/gemini.ts',
  'packages/code-agent/src/tools/apply-patch.ts',
  'packages/code-agent/src/tools/code-exec.ts',
  'packages/code-agent/src/tools/exec-command.ts',
  'packages/code-agent/src/tools/execute-tasks.ts',
  'packages/code-agent/src/tools/fs.ts',
  'packages/code-agent/src/tools/implement-subagent.ts',
  'packages/code-agent/src/tools/spawn-agent.ts',
  'packages/code-agent/src/tools/tasks.ts',
  'packages/code-agent/src/tools/tiers.ts',
  'packages/company/src/services/InboxQueue.ts',
  'packages/company/src/services/PipelineExecutor.ts',
  'packages/company/src/services/SandboxService.ts',
  'packages/company/src/services/supervisor/AgentSupervisor.ts',
  'packages/company/src/system-prompts.ts',
  'packages/company/src/tools/design-system/ds-publish-version.ts',
  'packages/company/src/tools/master-tools.ts',
  'packages/company/src/tools/subordinate-tools.ts',
  'packages/design-system/src/package-audit.ts',
  'packages/design-system/src/source-inventory.ts',
  'packages/indexer/src/indexer/tree-sitter/extractor.ts',
  'packages/indexer/src/search/embeddings.ts',
  'packages/indexer/src/search/hybrid.ts',
  'packages/indexer/src/search/hybrid-pipeline.ts',
  'packages/services/src/chrome-service/chrome-service.ts',
  'packages/services/src/sandbox/drivers/cli-oci-driver.ts',
  'packages/services/src/services/docs/auto-discovery.ts',
  'packages/services/src/services/docs/url-fetcher.ts',
  'packages/services/src/services/oauth/claude-code.ts',
  'packages/services/src/services/oauth/kimi-code.ts',
  'packages/services/src/verdaccio/verdaccio-service.ts',
  'packages/shared/src/types.ts',
  'packages/store/src/db.ts',
  'packages/store/src/skill-store.ts',
  'packages/store/src/vectors.ts',
]);

function shouldSkipDir(name: string): boolean {
  return name.startsWith('.') || EXCLUDE_DIRS.has(name);
}

function shouldSkipFile(name: string): boolean {
  for (const re of EXCLUDE_FILE_PATTERNS) {
    if (re.test(name)) return true;
  }
  if (!/\.(ts|tsx)$/.test(name)) return true;
  return false;
}

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (shouldSkipDir(entry)) continue;
    const abs = join(dir, entry);
    let s;
    try { s = statSync(abs); } catch { continue; }
    if (s.isDirectory()) {
      walk(abs, out);
    } else if (s.isFile() && !shouldSkipFile(entry)) {
      out.push(abs);
    }
  }
}

interface Violation {
  path: string;
  loc: number;
  level: 'WARN' | 'HARD';
}

function main(): void {
  const strict = process.argv.includes('--strict');
  const files: string[] = [];
  for (const root of ROOTS) {
    walk(join(REPO_ROOT, root), files);
  }

  const violations: Violation[] = [];
  for (const file of files) {
    const rel = relative(REPO_ROOT, file).split(sep).join('/');
    const text = readFileSync(file, 'utf8');
    const loc = text.split(/\r?\n/).length;
    if (loc <= SOFT_CAP) continue;
    if (loc > HARD_CAP) {
      if (LOC_ALLOWLIST[rel] || GRANDFATHERED.has(rel)) continue;
      violations.push({ path: rel, loc, level: 'HARD' });
    } else {
      violations.push({ path: rel, loc, level: 'WARN' });
    }
  }

  violations.sort((a, b) => b.loc - a.loc);

  const hard = violations.filter((v) => v.level === 'HARD');
  const warn = violations.filter((v) => v.level === 'WARN');

  if (warn.length > 0) {
    console.log(`\n⚠️  ${warn.length} file(s) over soft cap (${SOFT_CAP} LOC):`);
    for (const v of warn) {
      console.log(`   ${v.loc.toString().padStart(4)}  ${v.path}`);
    }
  }

  if (hard.length > 0) {
    console.log(`\n❌ ${hard.length} file(s) over hard cap (${HARD_CAP} LOC):`);
    for (const v of hard) {
      console.log(`   ${v.loc.toString().padStart(4)}  ${v.path}`);
    }
    console.log(
      `\n  Hard cap is ${HARD_CAP} LOC for source files (tests excluded). Either split, ` +
      `or add an allowlist entry with rationale in scripts/check-loc-cap.ts:LOC_ALLOWLIST.`,
    );
    process.exit(1);
  }

  if (strict && warn.length > 0) {
    console.log(`\n--strict: warnings treated as failures.`);
    process.exit(1);
  }

  console.log(
    `\n✅ ${files.length} file(s) scanned. ${hard.length} hard violation(s), ${warn.length} soft warning(s).`,
  );
}

main();
