import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertContainedPath,
  assertPathHasNoLinksSync,
  newSessionId,
  type SessionId,
} from '@mcp/session-storage';
import { toJsonValue } from './conversation-codec.js';
import type { FsSessionDirectory } from './session-directory.js';
import type { FsAppendMessageUsage } from './types.js';

function metricId(operationKey?: string): string {
  if (!operationKey) return `subagent-usage-${newSessionId()}`;
  const digest = createHash('sha256')
    .update('mcp-subagent-usage\0')
    .update(operationKey)
    .digest('hex')
    .slice(0, 32);
  return `subagent-usage-${digest}`;
}

/**
 * Record usage that does not belong to a canonical parent conversation turn,
 * such as a background subagent group settling after the spawning turn ended.
 *
 * An operation key makes replay idempotent. The immutable metric is the only
 * authority; global/session token projections are rebuilt from metrics/turns.
 */
export async function recordStandaloneSubagentUsage(
  directory: FsSessionDirectory,
  sessionId: SessionId | string,
  usage: FsAppendMessageUsage,
  operationKey?: string,
): Promise<void> {
  await directory.runMutation(sessionId, async () => {
    const entry = await directory.requireEntry(sessionId);
    const id = metricId(operationKey);
    const target = join(
      entry.location.bundle_path,
      'metrics',
      'turns',
      `${id}.json`,
    );
    assertContainedPath(entry.location.bundle_path, target);
    if (existsSync(target)) {
      assertPathHasNoLinksSync(entry.location.bundle_path, target);
      return;
    }
    await directory.repository.writeEntity(
      entry.location,
      'metrics/turns',
      id,
      toJsonValue({
        schema_version: 1,
        metric_kind: 'standalone_subagent_usage',
        id,
        operation_key: operationKey ?? null,
        turns: 0,
        tool_calls: 0,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
        },
        subagent_usage: {
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          cache_read_tokens: usage.cache_read_input_tokens ?? 0,
          cache_creation_tokens: usage.cache_creation_input_tokens ?? 0,
        },
        recorded_at: new Date().toISOString(),
      }),
    );
  });
}
