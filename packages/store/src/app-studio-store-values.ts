import type { AppStudioWorkItemRunStatus, AppStudioMetadata } from './app-studio-store-types.js';
import { type JsonValue, type ProjectId, type SessionMetadata } from '@mcp/session-storage';
export const TERMINAL_RUN_STATUSES = new Set<AppStudioWorkItemRunStatus>([
  'completed',
  'blocked',
  'error',
  'aborted',
  'interrupted',
  'cancelled',
]);

export function objectValue(value: JsonValue | undefined): Record<string, JsonValue> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {};
}

export function parseStringArray(value: string, label: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new TypeError(`${label} must be a JSON string array`);
  }
  return parsed;
}

export function appMetadata(session: SessionMetadata): AppStudioMetadata | null {
  const raw = objectValue(session.metadata.app_studio);
  if (
    !Number.isSafeInteger(raw.seq) ||
    typeof raw.project_id !== 'number' ||
    typeof raw.name !== 'string' ||
    typeof raw.app_slug !== 'string'
  ) {
    return null;
  }
  return {
    seq: raw.seq as number,
    project_id: raw.project_id as ProjectId,
    company_session_id:
      typeof raw.company_session_id === 'string'
        ? raw.company_session_id
        : null,
    name: raw.name,
    app_slug: raw.app_slug,
    stack_profile_id: 'cf-fullstack-v1',
  };
}
