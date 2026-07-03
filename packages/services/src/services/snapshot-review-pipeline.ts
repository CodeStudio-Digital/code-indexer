import {
  durationToBucket,
  sizeToBucket,
  type TelemetrySink,
} from '@mcp/candidate-pipeline/stats.js';
import {
  type PipelineProviderResolver,
  type ResolveContext,
  type ResolvedBinding,
} from '../pipelines/index.js';
import {
  callConfiguredChat,
  friendlyProviderError,
} from '../quality/binding-chat.js';
import { callChatWithFailover } from '../quality/binding-failover.js';
import type { FileDiff } from './session-snapshots.js';
import { MAX_CONTEXT_CHARS } from './snapshot-review-context.js';
import { buildMessages } from './snapshot-review-prompt.js';
import { filterReviewableDiffs } from './snapshot-review-ignore.js';

export type SnapshotReviewSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface SnapshotReviewFinding {
  severity: SnapshotReviewSeverity;
  filePath: string;
  baselineId?: number | null;
  hunkFingerprint?: string | null;
  oldLine?: number | null;
  newLine?: number | null;
  body: string;
  suggestedFix?: string | null;
  diffExcerpt?: string | null;
}

export interface SnapshotReviewResult {
  ok: boolean;
  findings: SnapshotReviewFinding[];
  raw: string;
  providerId?: string;
  modelId?: string;
  errorCode?: string;
  error?: string;
}

export interface SnapshotReviewInput {
  sessionKind: 'coder' | 'company';
  sessionId: number;
  resolveContext: ResolveContext;
  diffs: FileDiff[];
  /** Optional pre-rendered context block (snapshot-review-context.ts),
   *  prepended before the diffs in the reviewer prompt. Capped defensively. */
  contextText?: string | null;
}

const PIPELINE_NAME = 'snapshot_review';
const ROLE = 'reviewer';
const LABEL = `${PIPELINE_NAME}/${ROLE}`;
const MAX_DIFF_CHARS = 60_000;

function toNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n...[truncated]`;
}

function linePrefix(type: 'context' | 'add' | 'remove'): string {
  if (type === 'add') return '+';
  if (type === 'remove') return '-';
  return ' ';
}

function renderHunk(diff: FileDiff, hunk: FileDiff['hunks'][number]): string {
  const header = [
    `file=${diff.baseline.filePath}`,
    `baselineId=${diff.baseline.id}`,
    `hunkFingerprint=${hunk.fingerprint}`,
    `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
  ].join(' ');
  const body = hunk.lines
    .map((line) => {
      const oldPart = line.oldLine == null ? ' ' : String(line.oldLine);
      const newPart = line.newLine == null ? ' ' : String(line.newLine);
      return `${oldPart.padStart(5)} ${newPart.padStart(5)} ${linePrefix(line.type)}${line.content}`;
    })
    .join('\n');
  return `${header}\n${body}`;
}

function renderDiffs(diffs: FileDiff[]): { text: string; pendingHunks: number } {
  const chunks: string[] = [];
  let pendingHunks = 0;
  for (const diff of diffs) {
    if (diff.diffDisabled) {
      chunks.push(`FILE ${diff.baseline.filePath} baselineId=${diff.baseline.id}: diff disabled`);
      continue;
    }
    const hunks = diff.hunks.filter((h) => h.decision === 'pending');
    pendingHunks += hunks.length;
    for (const hunk of hunks) chunks.push(renderHunk(diff, hunk));
  }
  return { text: truncate(chunks.join('\n\n'), MAX_DIFF_CHARS), pendingHunks };
}

function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('empty response');
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (fenced) return JSON.parse(fenced);
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error('response was not JSON');
  }
}

function normalizeSeverity(value: unknown): SnapshotReviewSeverity {
  return value === 'critical' || value === 'high' || value === 'medium' || value === 'low'
    ? value
    : 'medium';
}

function toOptionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toOptionalString(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() ? truncate(value.trim(), max) : null;
}

function parseFindings(raw: string): SnapshotReviewFinding[] {
  const parsed = extractJson(raw) as { findings?: unknown };
  if (!Array.isArray(parsed.findings)) return [];
  const findings: SnapshotReviewFinding[] = [];
  for (const item of parsed.findings) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const filePath = toOptionalString(row.filePath, 1000);
    const body = toOptionalString(row.body, 4000);
    if (!filePath || !body) continue;
    findings.push({
      severity: normalizeSeverity(row.severity),
      filePath,
      baselineId: toOptionalNumber(row.baselineId),
      hunkFingerprint: toOptionalString(row.hunkFingerprint, 200),
      oldLine: toOptionalNumber(row.oldLine),
      newLine: toOptionalNumber(row.newLine),
      body,
      suggestedFix: toOptionalString(row.suggestedFix, 4000),
      diffExcerpt: toOptionalString(row.diffExcerpt, 4000),
    });
  }
  return findings;
}

export class SnapshotReviewPipeline {
  constructor(
    private readonly resolver: PipelineProviderResolver,
    private readonly telemetry?: TelemetrySink | null,
  ) {}

  async review(input: SnapshotReviewInput): Promise<SnapshotReviewResult> {
    const startedAt = performance.now();
    let binding: ResolvedBinding | null = null;
    let pendingHunks = 0;
    try {
      // resolveChain lets a second configured reviewer binding (or the general
      // default) take over when the primary is uncallable/down. The runner
      // skips misconfigured bindings internally, so the explicit bindingProblem
      // pre-check is no longer needed.
      const chain = await this.resolver.resolveChain(PIPELINE_NAME, ROLE, input.resolveContext);
      if (chain.length === 0) {
        return this.finish(input, startedAt, 0, 0, true, {
          ok: false,
          findings: [],
          raw: '',
          errorCode: 'review_pipeline_unconfigured',
          error: 'Configure snapshot_review/reviewer in Admin > Pipelines.',
        });
      }

      const rendered = renderDiffs(filterReviewableDiffs(input.diffs));
      pendingHunks = rendered.pendingHunks;
      const messages = buildMessages(
        rendered.text,
        input.contextText ? truncate(input.contextText, MAX_CONTEXT_CHARS) : undefined,
      );
      const failover = await callChatWithFailover(
        chain,
        (b) =>
          callConfiguredChat(b, messages, {
            temperature: 0,
            maxTokens: toNumber((b.config as Record<string, unknown>).max_tokens) ?? 4000,
          }),
        { label: LABEL, codePrefix: 'review_pipeline', retry: { maxRetries: 0 } },
      );
      const result = failover.result;
      binding = failover.binding ?? chain[0];
      if (result.errorBody) {
        return this.finish(input, startedAt, pendingHunks, 0, true, {
          ok: false,
          findings: [],
          raw: result.content,
          providerId: binding.provider.id,
          modelId: binding.modelId,
          errorCode: 'review_pipeline_provider_error',
          error: friendlyProviderError(binding, result.errorBody, LABEL),
        });
      }

      const findings = parseFindings(result.content);
      return this.finish(input, startedAt, pendingHunks, findings.length, false, {
        ok: true,
        findings,
        raw: result.content,
        providerId: binding.provider.id,
        modelId: binding.modelId,
      });
    } catch (e) {
      return this.finish(input, startedAt, pendingHunks, 0, true, {
        ok: false,
        findings: [],
        raw: '',
        providerId: binding?.provider.id,
        modelId: binding?.modelId,
        errorCode: 'review_pipeline_error',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  private finish(
    input: SnapshotReviewInput,
    startedAt: number,
    candidatesIn: number,
    candidatesOut: number,
    error: boolean,
    result: SnapshotReviewResult,
  ): SnapshotReviewResult {
    const durationMs = performance.now() - startedAt;
    try {
      this.telemetry?.emit({
        pipelineName: PIPELINE_NAME,
        stage: 'scorer',
        component: ROLE,
        durationMs,
        durationBucket: durationToBucket(durationMs),
        candidatesIn,
        candidatesOut,
        sizeBucket: sizeToBucket(candidatesIn),
        errors: error ? 1 : 0,
        sessionId: input.sessionKind === 'coder' ? input.sessionId : undefined,
        companySessionId: input.sessionKind === 'company' ? input.sessionId : undefined,
        diag: {
          providerId: result.providerId ?? null,
          modelId: result.modelId ?? null,
          errorCode: result.errorCode ?? null,
          error: result.error ?? null,
        },
      });
    } catch {
      /* telemetry is best-effort */
    }
    return result;
  }
}
