import { ApiError } from '@mcp/api-bus';

const SAFE_RUNTIME_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,80}$/;

/** Reject values that could escape managed roots or become shell syntax. */
export function assertRuntimeVersion(version: string): string {
  if (!SAFE_RUNTIME_VERSION.test(version)) {
    throw new ApiError('invalid', 400, `invalid runtime version: ${version}`);
  }
  return version;
}

/** Extract a validated version from a persisted `managed:<version>` id. */
export function managedVersionFromId(id: string | null | undefined): string | null {
  if (!id?.startsWith('managed:')) return null;
  return assertRuntimeVersion(id.slice('managed:'.length));
}
