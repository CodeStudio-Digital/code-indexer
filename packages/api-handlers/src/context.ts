/**
 * Helpers for constructing `ApiContext` instances inside the transport
 * adapters (Hono routes, Electron `ipcMain.handle`, tests).
 *
 * Handlers never construct context themselves — they receive it.
 */

import type { ApiContext, AuthenticatedUser } from '@mcp/api-bus';
import { randomUUID } from 'node:crypto';

export interface CreateContextInput {
  user?: AuthenticatedUser;
  requestId?: string;
  signal?: AbortSignal;
}

export function createContext(input: CreateContextInput = {}): ApiContext {
  return {
    user: input.user,
    requestId: input.requestId ?? randomUUID(),
    signal: input.signal ?? new AbortController().signal,
  };
}

/**
 * Build an `ApiContext` for trusted internal callers (tests, boot recovery,
 * cron jobs). Synthesizes a fake admin user so `requireTier('pro')` passes
 * without a real JWT. Never use on a public-facing surface.
 */
export function createInternalContext(): ApiContext {
  return createContext({
    user: {
      id: 'internal',
      email: 'internal@local',
      tier: 'pro',
    },
  });
}
