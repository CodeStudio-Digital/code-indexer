/**
 * How the dashboard reaches a sandbox preview.
 *
 * Phase C of the "living company" restructure removed the proxy
 * entirely — every preview is now `port-direct`. The other variants
 * are kept in the type so legacy DB rows continue to parse, but
 * `inferPreviewStrategy` always returns `port-direct` and consumers
 * should treat any other value as a synonym.
 *
 * - `port-direct`: The iframe loads `http://127.0.0.1:${hostPort}`
 *   directly. Single-user dev assumed.
 * - `proxy-prefix` / `proxy-root`: Legacy values, retained for
 *   backward-compatible DB reads only.
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
 * Phase C: every sandbox is `port-direct` — the dashboard now loads
 * the dev server straight from `http://127.0.0.1:<hostPort>/`. The
 * input is ignored but kept so the call sites don't need to change.
 */
export function inferPreviewStrategy(_input: InferPreviewStrategyInput): PreviewStrategy {
  return 'port-direct';
}
