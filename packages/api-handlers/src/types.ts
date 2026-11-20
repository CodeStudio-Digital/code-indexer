/**
 * Handler dependency surface — what every handler factory accepts.
 *
 * In practice this is the same object the legacy HTTP routes consume
 * (`ServerDeps` in apps/http-api/server/deps.ts). To avoid a tight coupling
 * from packages/ → apps/, we type it via the existing path alias and
 * narrow each handler factory to the subset it actually touches.
 *
 * If/when `createDeps` is moved to a package of its own, this re-export
 * becomes a direct import — no call sites change.
 */

import type { ServerDeps } from '@apps/http-api/server/deps.js';

export type HandlerDeps = ServerDeps;
