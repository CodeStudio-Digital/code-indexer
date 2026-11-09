/** Shared, behavior-neutral accounting for direct and nested tool calls. */
import { stableArgsKey } from './runner/dup-utils.js';
import type { ToolRiskLevel } from './tool.js';

export interface ToolCallLedgerEntry {
  seq: number;
  /** Wall-clock observation time for recency-aware tool selection. */
  timestampMs: number;
  name: string;
  logicalOperationId: string;
  productive: boolean;
  isError: boolean;
  refusalKind?: string;
  resultFingerprint: string;
  outcome: 'success' | 'tool_error' | 'refusal' | 'timeout' | 'cancelled';
  durationMs: number;
  /** Sanitized invocation classification; raw arguments are never retained. */
  mutates?: boolean;
  riskLevel?: ToolRiskLevel;
  executionClass?: string;
  repeatPolicy?: string;
  readCoverage?: { path: string; start: number | null; end: number | null };
  resultNovel: boolean;
  coverageNovel: boolean;
  /** Allowlisted validation command/tool label; never a raw command line. */
  validationSignal?: string;
  validationOutcome?: 'passed' | 'failed' | 'pending';
  /** First dispatch sequence; edits while an async check runs invalidate it. */
  validationStartedSeq?: number;
  /**
   * Hashed, allowlisted recovery identity for resumable orchestration.
   * This lets `resume_agent` / resumed `workflow` success resolve the exact
   * earlier partial operation without retaining raw prompts or tool input.
   */
  recoveryOperationId?: string;
}

const CONTINUATION_KEYS = new Set([
  'offset', 'limit', 'cursor', 'page', 'page_size',
]);
const READ_RANGE_KEYS = new Set(['start_line', 'end_line', 'line_start', 'line_end']);

function fnv1a(value: string): string {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function logicalArgs(name: string, value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (CONTINUATION_KEYS.has(key.toLowerCase())) continue;
    if (/(?:^|__)read_file$/.test(name) && READ_RANGE_KEYS.has(key.toLowerCase())) continue;
    // Nested filters and semantic start/end/before/after values are part of
    // the operation, even when their names resemble pagination controls.
    out[key] = child;
  }
  return out;
}

export function logicalOperationId(name: string, args: unknown): string {
  return `${name}:${fnv1a(stableArgsKey(logicalArgs(name, args)))}`;
}

class ToolCallAccounting {
  readonly terminalValidations = new Map<string, { signal: string; startedSeq: number }>();
  seq = 0;
  readonly entries: ToolCallLedgerEntry[] = [];
  readonly resultsByOperation = new Map<string, Set<string>>();
  readonly noProgressByOperation = new Map<string, number>();
  readonly coverage = new Set<string>();
  unsafeLane: Promise<void> = Promise.resolve();
}

export class ToolCallLedger {
  constructor(private readonly accounting = new ToolCallAccounting()) {}
  private get terminalValidations() { return this.accounting.terminalValidations; }
  private get seq() { return this.accounting.seq; }
  private set seq(value: number) { this.accounting.seq = value; }
  private get entries() { return this.accounting.entries; }
  private get resultsByOperation() { return this.accounting.resultsByOperation; }
  private get noProgressByOperation() { return this.accounting.noProgressByOperation; }
  private get coverage() { return this.accounting.coverage; }
  private get unsafeLane() { return this.accounting.unsafeLane; }
  private set unsafeLane(value: Promise<void>) { this.accounting.unsafeLane = value; }
  private uncertainTool: string | undefined;

  /** Sticky for this dispatch branch, including all still-running RAW descendants. */
  markOutcomeUnknown(toolName: string): void { this.uncertainTool ??= toolName; }
  get outcomeUnknownTool(): string | undefined { return this.uncertainTool; }

  /**
   * Only the host may advance after registering the incident in recovery state.
   * Keep accounting and unsafe-lane ownership: a timed-out RAW write still owns
   * its lane, and late callbacks keep their old branch fenced permanently.
   */
  continueAfterOutcomeRegistration(): ToolCallLedger { return new ToolCallLedger(this.accounting); }

  /**
   * Shared FIFO lane for mutations and other non-parallel-safe operations.
   * The caller hands the returned release callback to the RAW invocation,
   * so a timeout cannot unlock the lane while a non-cancellable write runs.
   */
  async reserveUnsafe(signal?: AbortSignal): Promise<() => void> {
    const abortError = (): Error => {
      const reason = signal?.reason;
      return reason instanceof Error ? reason : new Error('unsafe tool lane acquisition aborted');
    };
    if (signal?.aborted) throw abortError();

    const prior = this.unsafeLane;
    let release!: () => void;
    const reservation = new Promise<void>((resolve) => { release = resolve; });
    this.unsafeLane = prior.then(() => reservation, () => reservation);
    let released = false;
    const releaseOnce = (): void => {
      if (released) return;
      released = true;
      release();
    };

    if (signal) {
      try {
        await new Promise<void>((resolve, reject) => {
          const onAbort = (): void => {
            signal.removeEventListener('abort', onAbort);
            reject(abortError());
          };
          signal.addEventListener('abort', onAbort, { once: true });
          void prior.then(resolve, resolve).finally(() => {
            signal.removeEventListener('abort', onAbort);
          });
        });
      } catch (error) {
        // Keep FIFO ordering intact: once the prior owner releases, this
        // cancelled reservation immediately releases itself for the next one.
        void prior.then(releaseOnce, releaseOnce);
        throw error;
      }
      if (signal.aborted) {
        releaseOnce();
        throw abortError();
      }
    } else {
      await prior;
    }
    return releaseOnce;
  }

  get lastSeq(): number { return this.seq; }

  snapshot(afterSeq = 0): ToolCallLedgerEntry[] {
    return this.entries.filter((entry) => entry.seq > afterSeq).map((entry) => ({ ...entry }));
  }

  /** Repetition diagnostic; callers must not use frequency as an execution veto. */
  checkRepeat(input: {
    name: string;
    args: unknown;
    repeatPolicy?: string;
    mutates?: boolean;
  }): { operationId: string; count: number } | null {
    const operationId = logicalOperationId(input.name, input.args);
    if (input.mutates || input.repeatPolicy === 'mutating' || input.repeatPolicy === 'pollable') return null;
    const count = this.noProgressByOperation.get(operationId) ?? 0;
    return count >= 3 ? { operationId, count: count + 1 } : null;
  }

  resetNoProgress(): void {
    this.noProgressByOperation.clear();
  }

  record(input: {
    name: string;
    args: unknown;
    content: string;
    isError: boolean;
    /** Canonical internal payload; only allowlisted opaque ids are extracted. */
    structuredData?: unknown;
    refusalKind?: string;
    mutates?: boolean;
    riskLevel?: ToolRiskLevel;
    durationMs?: number;
    executionClass?: string;
    repeatPolicy?: string;
  }): ToolCallLedgerEntry {
    const operation = logicalOperationId(input.name, input.args);
    const fingerprint = fnv1a(input.content);
    const seen = this.resultsByOperation.get(operation) ?? new Set<string>();
    const novel = !seen.has(fingerprint);
    seen.add(fingerprint);
    this.resultsByOperation.set(operation, seen);
    const argRecord = input.args && typeof input.args === 'object'
      ? input.args as Record<string, unknown>
      : {};
    const path = typeof argRecord.path === 'string'
      ? argRecord.path
      : typeof argRecord.file_path === 'string' ? argRecord.file_path : null;
    const toLine = (value: unknown): number | null =>
      typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : null;
    const readCoverage = path && /(?:^|__)(?:read_file|get_symbol_body|get_file_skeleton)$/.test(input.name)
      ? {
          path,
          start: toLine(argRecord.start_line ?? argRecord.line_start ?? argRecord.offset),
          end: toLine(argRecord.end_line ?? argRecord.line_end),
        }
      : undefined;
    const coverageKey = readCoverage
      ? `${input.name}|${readCoverage.path}|${readCoverage.start ?? '*'}|${readCoverage.end ?? '*'}`
      : null;
    const coverageNovel = coverageKey != null && !this.coverage.has(coverageKey);
    if (coverageKey) this.coverage.add(coverageKey);
    const outcome = input.refusalKind === 'timeout'
      ? 'timeout'
      : input.refusalKind === 'abort' || input.refusalKind === 'cancelled'
        ? 'cancelled'
        : input.refusalKind
          ? 'refusal'
          : input.isError ? 'tool_error' : 'success';
    let validationSignal = extractValidationSignal(input.name, argRecord);
    let validationStartedSeq = this.seq + 1;
    let validationOutcome: ToolCallLedgerEntry['validationOutcome'];
    const terminalTool = ['exec_command', 'write_stdin', 'poll_session'].includes(input.name);
    const result = input.structuredData && typeof input.structuredData === 'object'
      ? input.structuredData as Record<string, unknown> : {};
    const sessionId = typeof result.sessionId === 'string' ? result.sessionId
      : typeof argRecord.session_id === 'string' ? argRecord.session_id : undefined;
    if (terminalTool && sessionId) {
      if (input.name === 'exec_command' && validationSignal) {
        this.terminalValidations.set(sessionId, { signal: validationSignal, startedSeq: validationStartedSeq });
      } else if (input.name !== 'exec_command') {
        // Interactive input changes what the shell executes; only empty polls
        // may complete the original check's receipt.
        if (typeof argRecord.chars === 'string' && argRecord.chars.length > 0) {
          this.terminalValidations.delete(sessionId);
        }
        const pending = this.terminalValidations.get(sessionId);
        validationSignal = pending?.signal;
        validationStartedSeq = pending?.startedSeq ?? validationStartedSeq;
      }
    }
    if (validationSignal) {
      validationOutcome = outcome !== 'success' ? 'failed'
        : terminalTool ? result.state === 'exited'
          ? result.exitCode === 0 ? 'passed' : 'failed'
          : 'pending'
        : 'passed';
      if (sessionId && validationOutcome !== 'pending') this.terminalValidations.delete(sessionId);
    }
    // Bound abandoned sessions independently from the retained ledger window.
    if (this.terminalValidations.size > 500) this.terminalValidations.delete(this.terminalValidations.keys().next().value!);
    const recoveryOperationId = extractRecoveryOperationId(
      input.name,
      argRecord,
      input.structuredData,
    );
    const entry: ToolCallLedgerEntry = {
      seq: ++this.seq,
      timestampMs: Date.now(),
      name: input.name,
      logicalOperationId: operation,
      productive: outcome === 'success' && (!!input.mutates || novel || coverageNovel),
      isError: input.isError,
      ...(input.refusalKind ? { refusalKind: input.refusalKind } : {}),
      resultFingerprint: fingerprint,
      outcome,
      durationMs: Math.max(0, input.durationMs ?? 0),
      ...(input.mutates !== undefined ? { mutates: input.mutates } : {}),
      ...(input.riskLevel ? { riskLevel: input.riskLevel } : {}),
      ...(input.executionClass ? { executionClass: input.executionClass } : {}),
      ...(input.repeatPolicy ? { repeatPolicy: input.repeatPolicy } : {}),
      ...(readCoverage ? { readCoverage } : {}),
      resultNovel: novel,
      coverageNovel,
      ...(validationSignal ? { validationSignal, validationOutcome, validationStartedSeq } : {}),
      ...(recoveryOperationId ? { recoveryOperationId } : {}),
    };
    this.entries.push(entry);
    while (this.entries.length > 500) this.entries.shift();
    if (outcome === 'success') {
      if (input.mutates || input.repeatPolicy === 'mutating' || input.executionClass === 'write' || input.executionClass === 'execute') {
        // Earlier read snapshots and counters describe a state that may have
        // changed. Keep the ledger and unsafe-operation protections intact.
        this.resultsByOperation.clear();
        this.coverage.clear();
        this.noProgressByOperation.clear();
      }
      if (input.mutates || input.repeatPolicy === 'mutating' || input.repeatPolicy === 'pollable' || entry.productive) {
        this.noProgressByOperation.set(operation, 0);
      } else {
        this.noProgressByOperation.set(operation, (this.noProgressByOperation.get(operation) ?? 0) + 1);
      }
    }
    return entry;
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

const PACKAGE_VALIDATION_SCRIPT =
  /(?:^|[:_-])(?:test|typecheck|lint|build|check|audit)(?:$|[:_-])/;
const PACKAGE_OPTIONS_WITH_VALUE = new Set([
  '--filter', '-f',
  '--workspace', '-w',
  '--dir', '-c',
  '--prefix',
  '--cwd',
  '--config',
]);

function cleanCommandToken(token: string): string {
  return token
    .replace(/^['"]|['"]$/g, '')
    .replace(/[;&|]+$/g, '');
}

function extractPackageValidationSignal(normalized: string): string | undefined {
  const packageManager = normalized.match(/^(npm|pnpm|yarn|bun)(?:\.cmd|\.exe)?\b/);
  if (!packageManager) return undefined;
  const manager = packageManager[1]!;
  const invocation = normalized.slice(packageManager.index! + packageManager[0].length);
  const tokens = invocation.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];

  for (let i = 0; i < tokens.length; i++) {
    const token = cleanCommandToken(tokens[i]!);
    if (token === 'run' || token === 'run-script') {
      const script = cleanCommandToken(tokens[i + 1] ?? '');
      return PACKAGE_VALIDATION_SCRIPT.test(script)
        ? `${manager} run ${script}`
        : undefined;
    }
    if (manager === 'yarn' && token === 'workspace') {
      i += 1; // skip the workspace name; its next positional is the script
      continue;
    }
    if (PACKAGE_OPTIONS_WITH_VALUE.has(token)) {
      i += 1; // a selector value named "test" is not itself a test command
      continue;
    }
    if (token.startsWith('-')) continue;
    return PACKAGE_VALIDATION_SCRIPT.test(token)
      ? `${manager} ${token}`
      : undefined;
  }
  return undefined;
}

/**
 * Extract only opaque control-plane ids from known first-party orchestration
 * results. The ledger stores their hash, never the raw id or arbitrary
 * structured output. Tool-name checks prevent a plugin from forging a
 * recovery relationship with an unrelated result shape.
 */
function extractRecoveryOperationId(
  name: string,
  args: Record<string, unknown>,
  structuredData: unknown,
): string | undefined {
  const data =
    structuredData && typeof structuredData === 'object' && !Array.isArray(structuredData)
      ? structuredData as Record<string, unknown>
      : null;
  const kind = nonEmptyString(data?.kind);

  if (name === 'spawn_agent') {
    const spawnId = kind === 'spawn_agent_result' || kind === 'spawn_agent_background_result'
      ? nonEmptyString(data?.spawnId)
      : null;
    return spawnId ? `subagent:${fnv1a(spawnId)}` : undefined;
  }

  if (name === 'resume_agent') {
    const structuredSpawnId = kind === 'resume_agent_result'
      ? nonEmptyString(data?.spawnId)
      : null;
    const spawnId = structuredSpawnId ?? nonEmptyString(args.spawn_id);
    return spawnId ? `subagent:${fnv1a(spawnId)}` : undefined;
  }

  if (name === 'collect_agents') {
    const spawnId = kind === 'collect_agents_result'
      ? nonEmptyString(data?.spawnId)
      : null;
    return spawnId ? `subagent:${fnv1a(spawnId)}` : undefined;
  }

  if (name === 'workflow') {
    const structuredWorkflowId = kind === 'workflow_result'
      ? nonEmptyString(data?.workflowId)
      : null;
    const workflowId = structuredWorkflowId ?? nonEmptyString(args.resume_workflow_id);
    return workflowId ? `workflow:${fnv1a(workflowId)}` : undefined;
  }

  return undefined;
}

/** Conservative recognition of a direct invocation, never a substring in echoed text.
 * Composite shell programs need a structured per-command receipt before they can
 * count as verification. Missing evidence must not turn into a success claim. */
export function extractValidationSignal(name: string, args: Record<string, unknown>): string | undefined {
  if (!['run_command', 'exec_command', 'shell_command'].includes(name)) return undefined;
  const command = [args.command, args.cmd, args.script].find((value): value is string => typeof value === 'string');
  if (command) {
    // Reject chaining, piping, substitution and redirection: exit zero for the
    // whole shell is not evidence that the validation command ran/passed.
    if (/[;&|<>`\r\n$#]/.test(command)) return undefined;
    const normalized = command.replace(/\s+/g, ' ').trim().toLowerCase();
    if (/(?:^|\s)(?:--help|-h|--version|--dry-run|--list(?:tests)?|--collect-only|--showconfig|--show-config)(?:[=\s]|$)/.test(normalized)) return undefined;
    if (/^(?:npm|pnpm|yarn|bun)\b/.test(normalized)
      && /(?:^|\s)(?:--cwd|--dir|--prefix|-c)(?:[=\s]+)(?!\.(?:\s|$))/.test(normalized)) return undefined;
    if (/^(?:(?:npx|pnpm exec|npm exec|yarn exec|bunx) )?tsc\b/.test(normalized)
      && /(?:^|\s)-v(?:\s|$)/.test(normalized)) return undefined;
    const packageValidation = extractPackageValidationSignal(normalized);
    if (packageValidation) return packageValidation;
    if (
      /^php(?:\.exe)?\s+(?:-d\s+\S+\s+)*(?:-l|--syntax-check)\b/.test(normalized)
    ) {
      // Keep the exact validation script (for example check:loc vs.
      // audit:env:check), or the PHP lint operation, without retaining flags,
      // paths, workspace names, or secrets.
      return 'php -l';
    }
    const patterns: Array<[RegExp, string]> = [
      [/^git diff --check\b/, 'git diff --check'],
      [/^(?:(?:npx|pnpm exec|npm exec|yarn exec|bunx) )?vitest(?: run)?\b/, 'vitest run'],
      [/^(?:(?:npx|pnpm exec|npm exec|yarn exec|bunx) )?jest\b/, 'jest'],
      [/^(?:(?:python|python3) -m )?pytest\b/, 'pytest'],
      [/^cargo (?:test|check|clippy|build)\b/, 'cargo validation'],
      [/^go (?:test|vet|build)\b/, 'go validation'],
      [/^dotnet (?:test|build)\b/, 'dotnet validation'],
      [/^(?:mvn|gradle|gradlew) (?:test|verify|check|build)\b/, 'jvm validation'],
      [/^(?:(?:npx|pnpm exec|npm exec|yarn exec|bunx) )?tsc(?: --noemit)?\b/, 'tsc --noEmit'],
      [/^(?:(?:npx|pnpm exec|npm exec|yarn exec|bunx) )?(?:eslint|biome check|ruff check|vite build)\b/, 'static validation'],
    ];
    for (const [pattern, label] of patterns) {
      const match = normalized.match(pattern);
      if (match) return label;
    }
  }
  return undefined;
}
