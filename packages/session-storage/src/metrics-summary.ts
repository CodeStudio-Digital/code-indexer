import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJson } from './atomic-file.js';
import {
  assertContainedPath,
  assertPathHasNoLinksSync,
} from './path-safety.js';
import type {
  JsonValue,
  SessionId,
  SessionMetricsSummary,
  SessionMetricTokenTotals,
  SessionStorageFaultInjector,
} from './types.js';

interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

interface TurnMetric {
  readonly turns: number;
  readonly toolCalls: number;
  readonly usage: UsageLike;
  readonly subagentUsage: UsageLike;
  readonly turnSeq: number | null;
  readonly messageSeq: number | null;
  readonly truncateFromMessageSeq: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return Number(value);
}

function usage(value: unknown, label: string): UsageLike {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return {
    input_tokens: nonNegativeInteger(value.input_tokens, `${label}.input_tokens`),
    output_tokens: nonNegativeInteger(value.output_tokens, `${label}.output_tokens`),
    cache_read_tokens: nonNegativeInteger(
      value.cache_read_tokens,
      `${label}.cache_read_tokens`,
    ),
    cache_creation_tokens: nonNegativeInteger(
      value.cache_creation_tokens,
      `${label}.cache_creation_tokens`,
    ),
  };
}

function jsonFiles(bundlePath: string, relativeDirectory: string): string[] {
  const directory = join(bundlePath, ...relativeDirectory.split('/'));
  assertContainedPath(bundlePath, directory);
  assertPathHasNoLinksSync(bundlePath, directory);
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const file = join(directory, name);
      assertContainedPath(directory, file);
      assertPathHasNoLinksSync(bundlePath, file);
      const stats = lstatSync(file);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error(`Metric is not a regular file: ${file}`);
      }
      return file;
    });
}

function addUsage(
  totals: SessionMetricTokenTotals,
  value: UsageLike,
): SessionMetricTokenTotals {
  return {
    input: totals.input + value.input_tokens,
    output: totals.output + value.output_tokens,
    cache_read: totals.cache_read + value.cache_read_tokens,
    cache_creation: totals.cache_creation + value.cache_creation_tokens,
  };
}

function optionalPositiveInteger(value: unknown, label: string): number | null {
  if (value == null) return null;
  const parsed = nonNegativeInteger(value, label);
  if (parsed < 1) throw new Error(`${label} must be positive`);
  return parsed;
}

function turnMetricValue(metric: JsonValue, label: string): TurnMetric {
  if (!isRecord(metric) || metric.schema_version !== 1) {
    throw new Error(`Invalid turn metric: ${label}`);
  }
  return {
    turns: nonNegativeInteger(metric.turns, `${label}.turns`),
    toolCalls: nonNegativeInteger(metric.tool_calls, `${label}.tool_calls`),
    usage: usage(metric.usage, `${label}.usage`),
    subagentUsage: usage(metric.subagent_usage, `${label}.subagent_usage`),
    turnSeq: optionalPositiveInteger(metric.turn_seq, `${label}.turn_seq`),
    messageSeq: optionalPositiveInteger(
      metric.message_seq,
      `${label}.message_seq`,
    ),
    truncateFromMessageSeq: optionalPositiveInteger(
      metric.truncate_from_message_seq,
      `${label}.truncate_from_message_seq`,
    ),
  };
}

function turnMetric(file: string): TurnMetric {
  return turnMetricValue(
    JSON.parse(readFileSync(file, 'utf8')) as JsonValue,
    file,
  );
}

export function emptySessionMetricsSummary(
  updatedAt = new Date().toISOString(),
): SessionMetricsSummary {
  return {
    schema_version: 1,
    updated_at: updatedAt,
    turns: 0,
    tool_calls: 0,
    provider_attempts: 0,
    tokens: {
      input: 0,
      output: 0,
      cache_read: 0,
      cache_creation: 0,
    },
  };
}

export function calculateSessionMetricsSummary(
  bundlePath: string,
  updatedAt = new Date().toISOString(),
  additionalTurnMetrics: readonly JsonValue[] = [],
): SessionMetricsSummary {
  let turns = 0;
  let toolCalls = 0;
  let tokens: SessionMetricTokenTotals =
    emptySessionMetricsSummary(updatedAt).tokens;

  const metrics = [
    ...jsonFiles(bundlePath, 'metrics/turns').map(turnMetric),
    ...additionalTurnMetrics.map((metric, index) =>
      turnMetricValue(metric, `additional turn metric ${index}`),
    ),
  ];
  const rollbacks = metrics.filter(
    (metric) =>
      metric.turnSeq != null &&
      metric.truncateFromMessageSeq != null,
  );
  for (const metric of metrics) {
    const hiddenByRollback =
      metric.turnSeq != null &&
      metric.messageSeq != null &&
      rollbacks.some(
        (rollback) =>
          rollback.turnSeq! > metric.turnSeq! &&
          metric.messageSeq! >= rollback.truncateFromMessageSeq!,
      );
    if (hiddenByRollback) continue;
    turns += metric.turns;
    toolCalls += metric.toolCalls;
    tokens = addUsage(tokens, metric.usage);
    tokens = addUsage(
      tokens,
      metric.subagentUsage,
    );
  }

  return {
    schema_version: 1,
    updated_at: updatedAt,
    turns,
    tool_calls: toolCalls,
    provider_attempts: jsonFiles(
      bundlePath,
      'metrics/provider_attempts',
    ).length,
    tokens,
  };
}

export function readSessionMetricsSummarySync(
  bundlePath: string,
): SessionMetricsSummary {
  const path = join(bundlePath, 'metrics', 'summary.json');
  assertContainedPath(bundlePath, path);
  assertPathHasNoLinksSync(bundlePath, path);
  const summary = JSON.parse(
    readFileSync(path, 'utf8'),
  ) as SessionMetricsSummary;
  const calculatedTokens = summary.tokens;
  if (
    summary.schema_version !== 1 ||
    typeof summary.updated_at !== 'string' ||
    !isRecord(calculatedTokens)
  ) {
    throw new Error(`Invalid metrics summary: ${path}`);
  }
  nonNegativeInteger(summary.turns, `${path}.turns`);
  nonNegativeInteger(summary.tool_calls, `${path}.tool_calls`);
  nonNegativeInteger(summary.provider_attempts, `${path}.provider_attempts`);
  nonNegativeInteger(calculatedTokens.input, `${path}.tokens.input`);
  nonNegativeInteger(calculatedTokens.output, `${path}.tokens.output`);
  nonNegativeInteger(calculatedTokens.cache_read, `${path}.tokens.cache_read`);
  nonNegativeInteger(
    calculatedTokens.cache_creation,
    `${path}.tokens.cache_creation`,
  );
  return summary;
}

export async function rebuildSessionMetricsSummary(
  bundlePath: string,
  sessionId: SessionId,
  faultInjector?: SessionStorageFaultInjector,
): Promise<SessionMetricsSummary> {
  const summary = calculateSessionMetricsSummary(bundlePath);
  await atomicWriteJson(join(bundlePath, 'metrics', 'summary.json'), summary, {
    faultInjector,
    context: { session_id: sessionId },
  });
  return summary;
}
