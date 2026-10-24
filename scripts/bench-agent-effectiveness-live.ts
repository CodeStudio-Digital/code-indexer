import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import process from 'node:process';

import type { AgentMessage, ChatUsage } from "@mcp/provider-sdk";
import type { CoderRunner } from '@mcp/code-agent/core/runner.js';
import type { AgentId } from '@mcp/code-agent/agents/index.js';
import { closeSharedCentral, runCoder } from '@mcp/code-agent/index.js';
import { stableArgsKey } from '@mcp/code-agent/core/runner/dup-utils.js';
import { runStructuralIndex } from '@mcp/indexer/indexer/structural.js';
import { CodeIndexDB } from '@mcp/store/db.js';
import { ProviderStore } from '@mcp/store/provider-store.js';
import { loadConfig } from '@mcp/shared/utils/config.js';

type CaseId =
  | 'explore_session_expiry'
  | 'plan_login_lockout'
  | 'build_invoice_rounding'
  | 'builder_paused_badge'
  | 'admin_release_branch';

interface BenchCase {
  id: CaseId;
  agent: AgentId;
  task: string;
  maxTurns: number;
  verify(ctx: VerifyContext): Verification;
}

interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  started: boolean;
  duration_ms?: number;
  is_error?: boolean;
  refusal_kind?: string;
  guard_action?: string;
  guard_reason?: string;
}

interface VerifyContext {
  root: string;
  changedFiles: string[];
  branch: string;
  finalText: string;
  plans: string[];
  tools: ToolCall[];
  test: CommandResult;
}

interface Verification {
  passed: boolean;
  checks: Record<string, boolean>;
  notes: string[];
}

interface GuardrailEvaluation {
  passed: boolean;
  checks: Record<string, boolean>;
  violations: string[];
}

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface RunResult {
  run_id: string;
  case_id: CaseId;
  agent: AgentId;
  provider: string;
  requested_model: string;
  effective_session_model: string;
  retrieval_guard: 'on' | 'off';
  repetition: number;
  project_id: number;
  project_root: string;
  session_id: string;
  index_status: {
    isIndexed: boolean;
    mcpAvailable: boolean;
    semantic: SemanticIndexResult | null;
  };
  terminal: { reason: string; error?: string };
  elapsed_ms: number;
  usage: ChatUsage;
  tool_calls: ToolCall[];
  provider_swaps: Array<{ provider: string; model: string }>;
  changed_files: string[];
  branch: string;
  final_text: string;
  plans: string[];
  tests: CommandResult;
  verification: Verification;
  guardrails: GuardrailEvaluation;
  efficiency: {
    passed: boolean;
    requested_tool_calls: number;
    executed_tool_calls: number;
    coalesced_tool_calls: number;
    max_tool_calls: number;
  };
}

interface SemanticIndexResult {
  enabled: boolean;
  project_id: number;
  generation_id: number;
  expected_items: number;
  indexed_items: number;
  failed_items: number;
  elapsed_ms: number;
}

const CASES: Record<CaseId, BenchCase> = {
  explore_session_expiry: {
    id: 'explore_session_expiry',
    agent: 'explore',
    maxTurns: 8,
    task:
      'Analise este projeto sem modificar arquivos. Onde a expiração de sessão é definida, '
      + 'como ela chega ao token e qual é a regra exata de expiração? Cite os arquivos e símbolos usados.',
    verify: (ctx) => {
      const answer = ctx.finalText.toLowerCase();
      const normalized = answer.normalize('NFKD').replace(/\p{Diacritic}/gu, '');
      const checks = {
        no_changes: ctx.changedFiles.length === 0,
        cites_policy_file: answer.includes('session-policy.js'),
        cites_token_file: answer.includes('token-service.js'),
        cites_config_file: answer.includes('src/config/security.js'),
        identifies_ttl: answer.includes('session_ttl_ms') || answer.includes('sessionttlms'),
        identifies_expiry_field: answer.includes('expiresat'),
        explains_boundary: answer.includes('>=') || answer.includes('maior ou igual') || answer.includes('igual'),
        identifies_disconnected_config:
          /\b(orfao|orfa|unused|nao usada|nao consumida|nao participa|nao conectad|duplicad|duas fontes|segunda fonte|desconectad|independent|fonte paralela)/.test(normalized),
      };
      return verdict(checks);
    },
  },
  plan_login_lockout: {
    id: 'plan_login_lockout',
    agent: 'plan',
    maxTurns: 10,
    task:
      'Planeje, mas não implemente, uma configuração central maxFailedAttempts para o bloqueio de login. '
      + 'O plano deve indicar arquivos exatos, compatibilidade, riscos e testes. Submeta o plano para revisão.',
    verify: (ctx) => {
      const plan = (ctx.plans[0] ?? '').toLowerCase();
      const checks = {
        submitted_plan: ctx.plans.length > 0,
        no_changes: ctx.changedFiles.length === 0,
        policy_file: plan.includes('src/auth/login-policy.js'),
        config_file: plan.includes('src/config/security.js'),
        test_file: plan.includes('test/login-policy.test.js'),
        names_setting: plan.includes('maxfailedattempts'),
        covers_tests: plan.includes('test'),
        covers_risk_or_compat: plan.includes('ris') || plan.includes('compat'),
      };
      return verdict(checks);
    },
  },
  build_invoice_rounding: {
    id: 'build_invoice_rounding',
    agent: 'build',
    maxTurns: 12,
    task:
      'Corrija o bug de arredondamento de calculateInvoice. A regra é aplicar desconto e imposto '
      + 'em precisão integral e arredondar somente o total final para centavos. Preserve a API e rode os testes. '
      + 'Não altere os testes.',
    verify: (ctx) => {
      const allowed = ['src/billing/invoice.js'];
      const source = readFileSync(join(ctx.root, allowed[0]), 'utf8');
      const functionBody = source.slice(source.indexOf('export function calculateInvoice'));
      const roundCalls = functionBody.match(/\broundMoney\s*\(/g)?.length ?? 0;
      const checks = {
        tests_pass: ctx.test.status === 0,
        only_allowed_file: sameSet(ctx.changedFiles, allowed),
        no_intermediate_rounding:
          !/const\s+discounted\s*=\s*roundMoney/.test(source)
          && roundCalls === 1,
      };
      return verdict(checks, ctx.test.status === 0 ? [] : [tail(ctx.test.stderr || ctx.test.stdout)]);
    },
  },
  builder_paused_badge: {
    id: 'builder_paused_badge',
    agent: 'builder',
    maxTurns: 12,
    task:
      'Corrija o componente textual renderStatusBadge: paused deve renderizar o modificador paused e o rótulo '
      + '"Pausado". Todo badge deve manter role="status" e ganhar aria-live="polite". Preserve active e rode os testes. '
      + 'Altere somente src/ui/status-badge.js.',
    verify: (ctx) => {
      const checks = {
        tests_pass: ctx.test.status === 0,
        only_allowed_file: sameSet(ctx.changedFiles, ['src/ui/status-badge.js']),
      };
      return verdict(checks, ctx.test.status === 0 ? [] : [tail(ctx.test.stderr || ctx.test.stdout)]);
    },
  },
  admin_release_branch: {
    id: 'admin_release_branch',
    agent: 'admin',
    maxTurns: 10,
    task:
      'Neste repositório isolado, crie e mude para a branch ops/benchmark-ready. Depois crie '
      + 'OPS_READY.md contendo exatamente duas linhas: "# Ops ready" e "status: verified". '
      + 'Não faça commit e não altere nenhum outro arquivo. Verifique o estado Git ao final.',
    verify: (ctx) => {
      const markerPath = join(ctx.root, 'OPS_READY.md');
      let marker = '';
      try { marker = readFileSync(markerPath, 'utf8').replace(/\r\n/g, '\n').trimEnd(); } catch { /* oracle handles */ }
      const checks = {
        correct_branch: ctx.branch === 'ops/benchmark-ready',
        exact_marker: marker === '# Ops ready\nstatus: verified',
        only_marker_changed: sameSet(ctx.changedFiles, ['OPS_READY.md']),
      };
      return verdict(checks);
    },
  },
};

function verdict(checks: Record<string, boolean>, notes: string[] = []): Verification {
  return { passed: Object.values(checks).every(Boolean), checks, notes };
}

function toolCallLimit(caseId: CaseId): number {
  return {
    explore_session_expiry: 6,
    plan_login_lockout: 10,
    build_invoice_rounding: 8,
    builder_paused_badge: 6,
    admin_release_branch: 4,
  }[caseId];
}

function sameSet(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length
    && [...actual].sort().every((value, index) => value === [...expected].sort()[index]);
}

function tail(value: string, chars = 1200): string {
  return value.length <= chars ? value : value.slice(-chars);
}

function run(command: string, args: string[], cwd: string): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: process.env,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error?.message ?? ''),
  };
}

function requireOk(result: CommandResult, label: string): void {
  if (result.status !== 0) {
    throw new Error(`${label} failed (${result.status}): ${tail(result.stderr || result.stdout)}`);
  }
}

function parseListFlag(name: string, fallback: string[]): string[] {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) return fallback;
  return process.argv[index + 1].split(',').map((value) => value.trim()).filter(Boolean);
}

function parseNumberFlag(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) return fallback;
  const parsed = Number.parseInt(process.argv[index + 1], 10);
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function parseGuardMode(): 'on' | 'off' {
  const index = process.argv.indexOf('--retrieval-guard');
  const value = index >= 0 ? process.argv[index + 1] : 'on';
  if (value !== 'on' && value !== 'off') {
    throw new Error('--retrieval-guard must be "on" or "off"');
  }
  return value;
}

function parseOnOffFlag(name: string, fallback: 'on' | 'off'): 'on' | 'off' {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : fallback;
  if (value !== 'on' && value !== 'off') {
    throw new Error(`${name} must be "on" or "off"`);
  }
  return value;
}

function parseStringFlag(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function ensureSemanticIndex(
  projectId: number,
  apiBase: string,
): Promise<SemanticIndexResult> {
  const fetchWithRetry = async (url: string, init?: RequestInit): Promise<Response> => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const response = await fetch(url, init);
        if (response.status < 500 || attempt === 3) return response;
        lastError = new Error(`HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
        if (attempt === 3) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt)));
    }
    throw lastError instanceof Error ? lastError : new Error('Semantic API request failed');
  };
  const startedAt = performance.now();
  const response = await fetchWithRetry(`${apiBase}/api/projects/${projectId}/semantic/reindex`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'start' }),
  });
  if (!response.ok) {
    throw new Error(
      `Semantic reindex rejected for project ${projectId} (${response.status}): ${await response.text()}`,
    );
  }

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const statusResponse = await fetchWithRetry(
      `${apiBase}/api/projects/${projectId}/semantic/status`,
      { headers: { Accept: 'application/json' } },
    );
    if (!statusResponse.ok) {
      throw new Error(
        `Semantic status failed for project ${projectId} (${statusResponse.status}): `
        + await statusResponse.text(),
      );
    }
    const status = await statusResponse.json() as {
      namespaces?: Array<{
        namespace: string;
        active?: { generationId?: number } | null;
        expected_items?: number;
        indexed_items?: number;
        failed_items?: number;
        last_error?: string | null;
      }>;
      reindex_job?: {
        status?: string;
        error?: string | null;
      } | null;
    };
    const code = status.namespaces?.find((row) => row.namespace === `code:p${projectId}`);
    const expected = code?.expected_items ?? 0;
    const indexed = code?.indexed_items ?? 0;
    const failed = code?.failed_items ?? 0;
    if (
      status.reindex_job?.status === 'completed'
      && code?.active?.generationId
      && expected > 0
      && indexed >= expected
      && failed === 0
    ) {
      return {
        enabled: true,
        project_id: projectId,
        generation_id: code.active.generationId,
        expected_items: expected,
        indexed_items: indexed,
        failed_items: failed,
        elapsed_ms: Math.round(performance.now() - startedAt),
      };
    }
    if (status.reindex_job?.status === 'failed' || status.reindex_job?.status === 'paused') {
      throw new Error(
        `Semantic reindex ${status.reindex_job.status} for project ${projectId}: `
        + (status.reindex_job.error ?? code?.last_error ?? 'unknown error'),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Semantic reindex timed out for project ${projectId}`);
}

function evaluateGuardrails(tools: ToolCall[]): GuardrailEvaluation {
  const executed = tools.filter((tool) => tool.started);
  const mutatingTool = (name: string): boolean =>
    /(?:^|__)(?:edit_file|multi_edit|create_file|write_file|apply_patch|delete_file|move_file|rename_file)$/.test(name);
  const duplicateKeys = new Set<string>();
  const duplicates = new Set<string>();
  let workspaceRevision = 0;
  for (const tool of executed) {
    const logicalKey = `${tool.name}:${stableArgsKey(tool.input)}`;
    // Re-reading or re-running a validator after a successful edit is new
    // evidence, not a duplicate. Exact repeated mutations remain duplicates.
    const key = mutatingTool(tool.name)
      ? `mutation:${logicalKey}`
      : `revision:${workspaceRevision}:${logicalKey}`;
    if (duplicateKeys.has(key)) duplicates.add(tool.name);
    duplicateKeys.add(key);
    if (!tool.is_error && mutatingTool(tool.name)) workspaceRevision += 1;
  }

  const skeletons = new Set(
    executed
      .filter((tool) => tool.name === 'mcp__get_file_skeleton')
      .map((tool) => String(tool.input.file_path ?? tool.input.path ?? ''))
      .filter(Boolean),
  );
  const overlappingReads = executed
    .filter((tool) => tool.name === 'mcp__read_file' || tool.name === 'read_file')
    .map((tool) => String(tool.input.file_path ?? tool.input.path ?? ''))
    .filter((path) => path && skeletons.has(path));
  // Plan submission is intentionally rejected by this harness after the first
  // plan is captured; that controlled interactive outcome is not a runtime
  // tool failure. All other tool errors remain guardrail violations.
  const errorTools = executed
    .filter((tool, index) => {
      if (!tool.is_error || tool.name === 'submit_plan') return false;
      const key = `${tool.name}:${stableArgsKey(tool.input)}`;
      return !executed.slice(index + 1).some((later) =>
        !later.is_error
        && `${later.name}:${stableArgsKey(later.input)}` === key);
    })
    .map((tool) => tool.name);
  const checks = {
    no_tool_errors: errorTools.length === 0,
    no_exact_duplicate_executions: duplicates.size === 0,
    no_skeleton_then_full_read: overlappingReads.length === 0,
  };
  const violations = [
    ...(errorTools.length ? [`tool errors: ${[...new Set(errorTools)].join(', ')}`] : []),
    ...(duplicates.size ? [`duplicate executions: ${[...duplicates].join(', ')}`] : []),
    ...(overlappingReads.length
      ? [`skeleton/full-read overlap: ${[...new Set(overlappingReads)].join(', ')}`]
      : []),
  ];
  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    violations,
  };
}

const RETRIEVAL_COALESCE_REASONS = new Set([
  'targeted-search-over-broad-map',
  'lower-relevance-sibling-search',
  'same-batch-grep-merge',
]);

function messageText(message: AgentMessage): string {
  return message.content
    .filter((block): block is Extract<(typeof message.content)[number], { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, '-');
}

function freshProject(runId: string, caseId: CaseId): string {
  const source = resolve('evals/agent-effectiveness/fixture');
  const root = resolve('.tmp/agent-effectiveness/runs', runId);
  mkdirSync(root, { recursive: true });
  cpSync(source, root, { recursive: true });
  if (caseId === 'build_invoice_rounding') {
    cpSync(
      resolve('evals/agent-effectiveness/seeds/invoice.js'),
      join(root, 'src/billing/invoice.js'),
    );
  }
  if (caseId === 'builder_paused_badge') {
    cpSync(
      resolve('evals/agent-effectiveness/seeds/status-badge.js'),
      join(root, 'src/ui/status-badge.js'),
    );
  }
  requireOk(run('git', ['init', '-q', '-b', 'main'], root), 'git init');
  requireOk(run('git', ['config', 'user.email', 'benchmark@mcp.local'], root), 'git config email');
  requireOk(run('git', ['config', 'user.name', 'MCP Benchmark'], root), 'git config name');
  requireOk(run('git', ['add', '.'], root), 'git add');
  requireOk(run('git', ['commit', '-q', '-m', 'oracle baseline'], root), 'git baseline commit');
  return root;
}

function changedFiles(root: string): string[] {
  const result = run('git', ['status', '--porcelain=v1', '-uall'], root);
  requireOk(result, 'git status');
  return result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3).replace(/\\/g, '/'))
    .sort();
}

function currentBranch(root: string): string {
  const result = run('git', ['branch', '--show-current'], root);
  return result.status === 0 ? result.stdout.trim() : '';
}

function attachObservers(
  runner: CoderRunner,
  caseId: CaseId,
  state: {
    finalTexts: string[];
    plans: string[];
    tools: ToolCall[];
    providerSwaps: Array<{ provider: string; model: string }>;
  },
): void {
  const byId = new Map<string, ToolCall>();
  const provideSoon = (value: string, askId?: string): void => {
    for (const delay of [0, 25, 100]) {
      const timer = setTimeout(() => {
        runner.provideUserInput(value, askId);
      }, delay);
      timer.unref();
    }
  };
  runner.on('tool_call_start', (id, name, input) => {
    const call = { id, name, input, started: true };
    byId.set(id, call);
    state.tools.push(call);
  });
  runner.on('tool_call_result', (id, name, result, durationMs) => {
    const call = byId.get(id) ?? {
      id,
      name,
      input: result.input ?? {},
      started: false,
    };
    if (!byId.has(id)) {
      byId.set(id, call);
      state.tools.push(call);
    }
    call.duration_ms = durationMs;
    call.is_error = !!result.isError;
    call.refusal_kind = result.refusalKind;
    call.guard_action = result.guardVerdict?.action;
    call.guard_reason = result.guardVerdict?.reason;
  });
  runner.on('message_complete', (message) => {
    const text = messageText(message);
    if (text.trim()) state.finalTexts.push(text);
  });
  runner.on('plan_posted', (block) => {
    state.plans.push(block.plan);
    if (caseId !== 'plan_login_lockout') {
      provideSoon(JSON.stringify({
        approved: true,
        feedback: 'Benchmark approval: implement the plan and validate the result.',
      }));
      return;
    }
    provideSoon(JSON.stringify({
      approved: false,
      aborted: true,
      feedback: 'Benchmark captured the submitted plan; do not implement.',
    }));
    // A rejected plan normally returns control to the model so it can revise.
    // This case measures the first submitted plan only; stop the runner after
    // the gate has consumed the response instead of paying for re-submissions.
    const stopTimer = setTimeout(() => runner.abort(), 50);
    stopTimer.unref();
  });
  runner.on('spec_posted', () => {
    provideSoon(JSON.stringify({ approved: false, aborted: true }));
  });
  runner.on('question_posted', (block) => {
    provideSoon(JSON.stringify({
      answer: block.options?.[0]?.value ?? 'Use os requisitos explícitos da tarefa e prossiga.',
    }));
  });
  runner.on('decision_posted', (payload) => {
    const answers = Object.fromEntries(payload.questions.map((question) => [
      question.id,
      question.options[0]?.value ?? '',
    ]));
    provideSoon(JSON.stringify({ answers }));
  });
  runner.on('tool_approval_request', (payload) => {
    provideSoon(
      JSON.stringify({ approved: true, alwaysAllow: true }),
      `tool_approval:${payload.toolUseId}`,
    );
  });
  runner.on('provider_swapped', (provider, model) => {
    state.providerSwaps.push({ provider, model });
  });
}

async function executeCase(
  benchCase: BenchCase,
  model: string,
  repetition: number,
  retrievalGuard: 'on' | 'off',
  semanticIndex: 'on' | 'off',
  apiBase: string,
): Promise<RunResult> {
  const runId = `${Date.now()}-${benchCase.id}-${safeName(model)}-r${repetition}-${randomUUID().slice(0, 8)}`;
  const root = freshProject(runId, benchCase.id);
  const config = loadConfig();
  const setupDb = new CodeIndexDB(config.dbPath);
  let project = setupDb.getProjectByPath(root);
  if (!project) {
    project = setupDb.createProject(`agent-eval-${runId}`, root, 'Deterministic live agent benchmark');
  }
  setupDb.setProjectMemoryEnabled(project.id, false);
  await runStructuralIndex(setupDb, project.id, {
    concurrency: 2,
    maxFileSizeKB: 256,
    ignorePatterns: ['.git/**', '.mcp-indexer/**'],
  });
  setupDb.close();
  const semantic = semanticIndex === 'on'
    ? await ensureSemanticIndex(project.id, apiBase)
    : null;

  const state = {
    finalTexts: [] as string[],
    plans: [] as string[],
    tools: [] as ToolCall[],
    providerSwaps: [] as Array<{ provider: string; model: string }>,
  };
  const abort = new AbortController();
  let activeRunner: CoderRunner | null = null;
  const timeout = setTimeout(() => {
    abort.abort(new Error('benchmark timeout'));
    activeRunner?.abort();
  }, 6 * 60_000);
  timeout.unref();
  const startedAt = performance.now();
  try {
    const handle = await runCoder({
      session: {
        create: {
          project_id: project.id,
          title: `[eval] ${benchCase.id} ${model}`,
          provider: 'zai',
          model,
        },
      },
      userMessage: benchCase.task,
      agent: benchCase.agent,
      maxTurns: benchCase.maxTurns,
      signal: abort.signal,
      toolPermissionMode: 'unrestricted',
      unsupervised: true,
      onRunnerReady: (runner) => {
        activeRunner = runner;
        attachObservers(runner, benchCase.id, state);
      },
    });
    let terminal: { reason: string; usage: ChatUsage; error?: string };
    try {
      terminal = await handle.done;
    } catch (error) {
      terminal = {
        reason: 'runner_error',
        usage: { input_tokens: 0, output_tokens: 0 },
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const elapsedMs = Math.round(performance.now() - startedAt);
    const tests = run('node', ['--test'], root);
    const finalText = state.finalTexts.at(-1) ?? '';
    const verifyContext: VerifyContext = {
      root,
      changedFiles: changedFiles(root),
      branch: currentBranch(root),
      finalText,
      plans: state.plans,
      tools: state.tools,
      test: tests,
    };
    const verification = benchCase.verify(verifyContext);
    const guardrails = evaluateGuardrails(state.tools);
    const executedToolCalls = state.tools.filter((tool) => tool.started).length;
    const coalescedToolCalls = state.tools.filter(
      (tool) =>
        !tool.started
        && tool.guard_action === 'reuse'
        && RETRIEVAL_COALESCE_REASONS.has(tool.guard_reason ?? ''),
    ).length;
    const maxToolCalls = toolCallLimit(benchCase.id);
    return {
      run_id: runId,
      case_id: benchCase.id,
      agent: benchCase.agent,
      provider: 'zai',
      requested_model: model,
      effective_session_model: handle.session.model,
      retrieval_guard: retrievalGuard,
      repetition,
      project_id: project.id,
      project_root: root,
      session_id: handle.session.id,
      index_status: {
        ...handle.indexStatus,
        semantic,
      },
      terminal: {
        reason: terminal.reason,
        ...(terminal.error ? { error: terminal.error } : {}),
      },
      elapsed_ms: elapsedMs,
      usage: terminal.usage,
      tool_calls: state.tools,
      provider_swaps: state.providerSwaps,
      changed_files: verifyContext.changedFiles,
      branch: verifyContext.branch,
      final_text: finalText,
      plans: state.plans,
      tests,
      verification,
      guardrails,
      efficiency: {
        passed: executedToolCalls <= maxToolCalls,
        requested_tool_calls: state.tools.length,
        executed_tool_calls: executedToolCalls,
        coalesced_tool_calls: coalescedToolCalls,
        max_tool_calls: maxToolCalls,
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

function markdownReport(
  results: RunResult[],
  models: string[],
  retrievalGuard: 'on' | 'off',
): string {
  const lines = [
    '# Live agent effectiveness report',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Retrieval guard: ${retrievalGuard}`,
    '',
    '| Model | Agent | Case | Correct | Guardrails | Efficient | Requested | Executed | Coalesced | Input | Output | Cache read | Time |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const result of results) {
    lines.push(
      `| ${result.requested_model} | ${result.agent} | ${result.case_id} `
      + `| ${result.verification.passed ? 'PASS' : 'FAIL'} `
      + `| ${result.guardrails.passed ? 'PASS' : 'FAIL'} `
      + `| ${result.efficiency.passed ? 'PASS' : `FAIL (max ${result.efficiency.max_tool_calls})`} `
      + `| ${result.efficiency.requested_tool_calls} `
      + `| ${result.efficiency.executed_tool_calls} `
      + `| ${result.efficiency.coalesced_tool_calls} `
      + `| ${result.usage.prompt_tokens_total ?? result.usage.input_tokens} `
      + `| ${result.usage.output_tokens} | ${result.usage.cache_read_input_tokens ?? 0} `
      + `| ${(result.elapsed_ms / 1000).toFixed(1)}s |`,
    );
  }
  lines.push('', '## Aggregate', '');
  for (const model of models) {
    const subset = results.filter((result) => result.requested_model === model);
    const passed = subset.filter((result) => result.verification.passed).length;
    const guarded = subset.filter((result) => result.guardrails.passed).length;
    const efficient = subset.filter(
      (result) => result.verification.passed && result.guardrails.passed && result.efficiency.passed,
    ).length;
    const input = subset.reduce((sum, result) => sum + (result.usage.prompt_tokens_total ?? result.usage.input_tokens), 0);
    const output = subset.reduce((sum, result) => sum + result.usage.output_tokens, 0);
    const elapsed = subset.reduce((sum, result) => sum + result.elapsed_ms, 0);
    lines.push(
      `- ${model}: ${passed}/${subset.length} correct, ${guarded}/${subset.length} guardrail-clean, `
      + `${efficient}/${subset.length} correct, guardrail-clean and efficient; ${input} input tokens; `
      + `${output} output tokens; ${(elapsed / 1000).toFixed(1)}s.`,
    );
  }
  lines.push('', '## Guardrail violations', '');
  const guardrailFailures = results.filter((result) => !result.guardrails.passed);
  if (guardrailFailures.length === 0) {
    lines.push('None.');
  } else {
    for (const failure of guardrailFailures) {
      lines.push(
        `- ${failure.requested_model}/${failure.case_id}: ${failure.guardrails.violations.join('; ')}.`,
      );
    }
  }
  lines.push('', '## Failed checks', '');
  const failures = results.filter((result) => !result.verification.passed);
  if (failures.length === 0) {
    lines.push('None.');
  } else {
    for (const failure of failures) {
      const failed = Object.entries(failure.verification.checks)
        .filter(([, ok]) => !ok)
        .map(([name]) => name)
        .join(', ');
      lines.push(`- ${failure.requested_model}/${failure.case_id}: ${failed}.`);
    }
  }
  lines.push(
    '',
    'Raw JSON beside this file contains final answers, plans, tool calls, changed files, '
    + 'provider swaps, terminal reasons and verifier evidence.',
    '',
  );
  return lines.join('\n');
}

async function main(): Promise<void> {
  process.env.CODER_GOAL_VERIFY = '0';
  process.env.CODER_FINISH_EVIDENCE_ROLLOUT_PERCENT = '100';
  process.env.CODER_FALLBACK_CHAIN = '';

  const models = parseListFlag('--models', ['glm-4.7-flash::coding', 'glm-5.2']);
  const caseIds = parseListFlag('--cases', Object.keys(CASES)) as CaseId[];
  const repetitions = parseNumberFlag('--repetitions', 1);
  const retrievalGuard = parseGuardMode();
  const semanticIndex = parseOnOffFlag('--semantic-index', 'on');
  const apiBase = parseStringFlag('--api-base', 'http://127.0.0.1:7333').replace(/\/+$/, '');
  process.env.CODER_RETRIEVAL_GUARD = retrievalGuard === 'on' ? '1' : '0';
  for (const caseId of caseIds) {
    if (!CASES[caseId]) throw new Error(`Unknown case: ${caseId}`);
  }

  const config = loadConfig();
  const providers = new ProviderStore(config.dbPath);
  const zai = providers.getProvider('zai');
  const enabled = providers.listModels('zai', true);
  providers.close();
  if (!zai?.enabled || !zai.use_for_coder) throw new Error('Configured Z.AI coder provider is unavailable');
  for (const requested of models) {
    const [id, mode = ''] = requested.split('::');
    if (!enabled.some((model) => model.model_id === id && (!mode || model.mode === mode))) {
      throw new Error(`Configured Z.AI model is unavailable: ${requested}`);
    }
  }

  const jobs: Array<{ benchCase: BenchCase; model: string; repetition: number }> = [];
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    for (const benchCase of caseIds.map((id) => CASES[id])) {
      for (const model of models) jobs.push({ benchCase, model, repetition });
    }
  }
  // Pair by case and alternate model order each repetition to reduce warm-cache/order bias.
  if (repetitions % 2 === 0) jobs.reverse();

  const results: RunResult[] = [];
  const reportDir = resolve('.tmp/agent-effectiveness/reports');
  mkdirSync(reportDir, { recursive: true });
  const checkpoint = join(reportDir, `in-progress-${process.pid}.json`);
  for (const [index, job] of jobs.entries()) {
    process.stderr.write(
      `[agent-eval ${index + 1}/${jobs.length}] ${job.model} ${job.benchCase.agent}/${job.benchCase.id}\n`,
    );
    const result = await executeCase(
      job.benchCase,
      job.model,
      job.repetition,
      retrievalGuard,
      semanticIndex,
      apiBase,
    );
    results.push(result);
    writeFileSync(
      checkpoint,
      `${JSON.stringify({
        models,
        caseIds,
        repetitions,
        retrievalGuard,
        semanticIndex,
        apiBase,
        completed: results.length,
        results,
      }, null, 2)}\n`,
      'utf8',
    );
    process.stderr.write(
      `  ${result.verification.passed ? 'PASS' : 'FAIL'} `
      + `${result.elapsed_ms}ms requested/executed/coalesced=`
      + `${result.efficiency.requested_tool_calls}/`
      + `${result.efficiency.executed_tool_calls}/`
      + `${result.efficiency.coalesced_tool_calls} `
      + `tokens=${result.usage.prompt_tokens_total ?? result.usage.input_tokens}/${result.usage.output_tokens}\n`,
    );
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = resolve('.tmp/agent-effectiveness/reports', `agent-effectiveness-${stamp}`);
  writeFileSync(
    `${base}.json`,
    `${JSON.stringify({
      models,
      caseIds,
      repetitions,
      retrievalGuard,
      semanticIndex,
      apiBase,
      results,
    }, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(`${base}.md`, markdownReport(results, models, retrievalGuard), 'utf8');
  process.stdout.write(`${base}.md\n${base}.json\n`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeSharedCentral();
  });
