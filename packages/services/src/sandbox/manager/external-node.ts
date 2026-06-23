/**
 * Pure helpers for running an external user-provided Node project (Next,
 * Vite, Angular, generic) inside a managed sandbox container.
 *
 * These helpers were inlined as private methods of `SandboxManager`
 * (lines 2856-2975 of sandbox-manager.ts). Extracting them as named pure
 * functions:
 *   - Lets test suites cover the framework / port / arg inference
 *     without spinning a real container.
 *   - Pins the contract so future scaffolder changes don't accidentally
 *     break the inference heuristics.
 *   - Cuts the sandbox-manager.ts LOC count without touching the
 *     orchestration path.
 *
 * Used by the manager's `resolveExternalNodeDevSpec` /
 * `startExternalNodeDevServer` / `ensureExternalNodeDependencies` paths
 * via thin wrapper methods on the class.
 */
import type {
  NodeManifest,
  NodePackageManager,
} from '@mcp/services/sandbox/manifest-detector/types.js';
import type { SandboxStack } from '@mcp/services/sandbox/types.js';
import { shQuote } from '@mcp/services/sandbox/manager/util/shell.js';

export type ExternalNodeFramework = 'angular' | 'next' | 'vite' | 'generic';

export interface ExternalNodeDevSpec {
  manifest: NodeManifest;
  packageManager: NodePackageManager;
  scriptName: string;
  scriptBody: string;
  containerPort: number;
  framework: ExternalNodeFramework;
}

/**
 * Extract a port from a `--port 1234` / `--port=1234` / `-p 1234` flag
 * baked into a package.json script. Returns null when nothing parses;
 * caller falls back to framework defaults.
 */
export function inferExternalNodeScriptPort(scriptBody: string): number | null {
  const match =
    scriptBody.match(/(?:^|\s)--port(?:=|\s+)(\d{2,5})(?=\s|$)/) ??
    scriptBody.match(/(?:^|\s)-p\s+(\d{2,5})(?=\s|$)/);
  if (!match) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

/**
 * Identify the dev-server framework from the stack name + the dev
 * script body. Order matters: Angular's `ng serve` and Next's
 * `next dev` are unambiguous; Vite is detected via the literal binary
 * name; everything else is `generic`.
 */
export function inferExternalNodeFramework(
  stack: SandboxStack,
  scriptBody: string,
): ExternalNodeFramework {
  const script = scriptBody.toLowerCase();
  if (stack === 'angular' || /\bng\s+serve\b/.test(script)) return 'angular';
  if (/\bnext\s+(dev|start)\b/.test(script)) return 'next';
  if (/\bvite\b/.test(script)) return 'vite';
  return 'generic';
}

/**
 * Framework-default container port when the script didn't pin one. The
 * `defaultDevServerPort` parameter is the manager's general fallback
 * (5173 for Vite-flavored stacks).
 */
export function inferExternalNodePort(
  framework: ExternalNodeFramework,
  defaultDevServerPort: number,
): number {
  switch (framework) {
    case 'angular':
      return 4200;
    case 'next':
      return 3000;
    case 'vite':
    case 'generic':
      return defaultDevServerPort;
  }
}

/**
 * Shell command that installs dependencies for the project's chosen
 * package manager. `corepack enable` runs first for `pnpm` / `yarn` so
 * the container picks up Yarn Berry / pnpm versions declared in
 * `packageManager` without us baking those binaries into the image.
 */
export function externalNodeInstallCommand(pm: NodePackageManager): string {
  if (pm === 'pnpm') {
    return 'corepack enable >/tmp/external-node-install.log 2>&1 || true; pnpm install --frozen-lockfile=false';
  }
  if (pm === 'yarn') {
    return 'corepack enable >/tmp/external-node-install.log 2>&1 || true; yarn install';
  }
  return 'npm install --no-audit --no-fund --loglevel=error';
}

/**
 * Build the framework-specific dev-server arg list that's appended (or
 * `--`-forwarded) to the user's `dev` script. The args supply: bind
 * host, container port, and the path-prefix tweaks the preview proxy
 * needs (`--base` for Vite, `--serve-path`/`--disable-host-check`/poll
 * for Angular). Args already present in the user's script are NEVER
 * duplicated — we sniff each flag and skip when seen.
 */
export function externalNodeRunArgs(
  spec: ExternalNodeDevSpec,
  previewPathPrefix: string,
): string {
  const script = spec.scriptBody.toLowerCase();
  const hasHost = /(?:^|\s)--(?:host|hostname)(?:[=\s]|$)/.test(script);
  const hasPort = /(?:^|\s)(?:--port|-p)(?:[=\s]|$)/.test(script);
  const args: string[] = [];

  if (spec.framework === 'next') {
    if (!hasHost) args.push('--hostname 0.0.0.0');
    if (!hasPort) args.push(`--port ${spec.containerPort}`);
    return args.join(' ');
  }

  if (!hasHost) args.push('--host 0.0.0.0');
  if (!hasPort) args.push(`--port ${spec.containerPort}`);
  if (spec.framework === 'angular') {
    if (!/(?:^|\s)--disable-host-check(?:[=\s]|$)/.test(script)) {
      args.push('--disable-host-check');
    }
    if (!/(?:^|\s)--poll(?:[=\s]|$)/.test(script)) {
      args.push('--poll=300');
    }
    if (!/(?:^|\s)--serve-path(?:[=\s]|$)/.test(script)) {
      args.push(`--serve-path=${shQuote(previewPathPrefix)}`);
    }
  } else if (spec.framework === 'vite') {
    if (!/(?:^|\s)--base(?:[=\s]|$)/.test(script)) {
      args.push(`--base=${shQuote(previewPathPrefix)}`);
    }
  }
  return args.join(' ');
}

/**
 * Final shell command that boots the dev server: corepack toggle for
 * pnpm/yarn, then the script invocation with framework args attached.
 * Yarn uses `yarn <script>` (no `run` prefix), the others use the
 * standard `<pm> run <script> -- <args>` pattern.
 */
export function externalNodeRunCommand(
  spec: ExternalNodeDevSpec,
  previewPathPrefix: string,
): string {
  const args = externalNodeRunArgs(spec, previewPathPrefix);
  const suffix = args ? ` ${args}` : '';
  const corepack =
    spec.packageManager === 'pnpm' || spec.packageManager === 'yarn'
      ? 'corepack enable >/tmp/external-node-corepack.log 2>&1 || true; '
      : '';
  if (spec.packageManager === 'yarn') {
    return `${corepack}yarn ${shQuote(spec.scriptName)}${suffix}`;
  }
  return `${corepack}${spec.packageManager} run ${shQuote(spec.scriptName)}${args ? ` -- ${args}` : ''}`;
}

/**
 * Probe command — returns non-zero when `node_modules` is missing /
 * incomplete. The bundlers list (`rollup`, `esbuild`) catches the
 * "installed but corrupted" case Vite / Next hit on stale containers;
 * a clean `node_modules/.bin` alone isn't enough.
 */
export function externalNodeDependencyProbeCommand(): string {
  return `test -d node_modules && test -d node_modules/.bin && node -e "for (const mod of ['rollup','esbuild']) { try { require.resolve(mod); } catch { continue; } require(mod); }"`;
}
