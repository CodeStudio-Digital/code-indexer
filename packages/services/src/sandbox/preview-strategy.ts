/**
 * How the dashboard reaches a sandbox preview.
 *
 * - `proxy-prefix`: Dev server scaffolded with `--base /preview/${id}/`.
 *   The iframe loads `/preview/${id}/`, the preview proxy forwards the
 *   path verbatim. This is the legacy behavior every existing service
 *   uses by default.
 *
 * - `proxy-root`: Dev server expects to serve at `/` but the iframe
 *   still goes through the proxy. The proxy strips the `/preview/${id}/`
 *   prefix before forwarding and rewrites root-relative URLs in HTML/JS
 *   responses so paths like `/main.js` resolve correctly under the
 *   prefix. See `usesRootRelativePreview` in `apps/http-api/server/routes/preview.ts`.
 *
 * - `port-direct`: The iframe loads `http://localhost:${hostPort}`
 *   directly, bypassing the proxy entirely. Use this when the dev
 *   server doesn't tolerate path rewriting — Next.js dev, generic
 *   Vite with `--base /`, raw Express, anything serving from `/` and
 *   relying on absolute URLs at runtime. Only viable when the dashboard
 *   and the host port are reachable from the same origin (i.e., local
 *   development); deployed installs must fall back to a proxy strategy.
 */
export type PreviewStrategy = 'proxy-prefix' | 'proxy-root' | 'port-direct';

export const PREVIEW_STRATEGIES: readonly PreviewStrategy[] = [
  'proxy-prefix',
  'proxy-root',
  'port-direct',
] as const;

export function isPreviewStrategy(value: unknown): value is PreviewStrategy {
  return typeof value === 'string' && (PREVIEW_STRATEGIES as readonly string[]).includes(value);
}

export interface InferPreviewStrategyInput {
  /** Free-form stack key from the scaffolder registry (e.g. 'react-ts'). */
  stack?: string;
  /** Whether the workspace files are owned by the builder or user-mounted. */
  mountKind?: 'owned' | 'external';
  /** When true the image is built from a project Dockerfile (we don't control flags). */
  fromProjectDockerfile?: boolean;
}

/**
 * Pick a sensible default strategy for a new sandbox. The result is
 * persisted as `preview_strategy` and can later be overridden by the
 * operator from the UI.
 *
 * Heuristic:
 *   1. External mounts → `port-direct`. The user wrote whatever Vite/Next
 *      config they wanted; we shouldn't assume the proxy prefix.
 *   2. Project Dockerfiles → `port-direct` for the same reason.
 *   3. Built-in stacks we scaffold (`react-ts`, `vue-ts`, etc.) →
 *      `proxy-prefix` because our scaffolder injects `--base /preview/${id}/`.
 *   4. Anything else → `proxy-prefix` as the safest fallback.
 *
 * Phase 4 only ships strategies (1) and (3); `proxy-root` and the
 * full external manifest inspection from `inferExternalPreviewFramework`
 * land in Phase 4b along with the proxy-side rewrites.
 */
export function inferPreviewStrategy(input: InferPreviewStrategyInput): PreviewStrategy {
  if (input.mountKind === 'external') return 'port-direct';
  if (input.fromProjectDockerfile) return 'port-direct';
  return 'proxy-prefix';
}
