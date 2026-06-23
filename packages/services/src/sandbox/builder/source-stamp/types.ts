/**
 * Framework-agnostic contract for "source stamping" — the build-time
 * transform that annotates every rendered DOM element with a
 * `data-mcp-loc="<relpath>:<line>:<col>"` attribute. That attribute is
 * what lets the dashboard map a clicked pixel back to the exact source
 * line for the builder agent to edit.
 *
 * Only the stamping is framework-specific (React via Babel, Vue via the
 * SFC compiler). Everything downstream — the inspector runtime, the
 * postMessage protocol, the dashboard selection hooks — operates purely
 * on the rendered DOM + `data-mcp-loc`, so it is framework-agnostic.
 */
import type { SandboxStack, ViteStampContribution } from '../../types.js';

/** A file the scaffolder writes into the project workdir. */
export interface StampFile {
  /** Path relative to the project workdir (e.g. `.mcp/babel-mcp-stamp.cjs`). */
  path: string;
  contents: string;
}

/**
 * Everything a stamp plugin contributes to a scaffolded project.
 *
 *   - `vite` → spliced into the canonical `vite.config.ts` (and persisted
 *     on the Sandbox so it survives dev-server restart — see
 *     `ViteStampContribution`).
 *   - `files` → written verbatim into the workdir (babel plugin, inspector
 *     runtime).
 *   - `entry` → a dev-only import appended to the app entry so the
 *     inspector loads in the browser.
 */
export interface StampContribution {
  vite: ViteStampContribution;
  files: StampFile[];
  entry: {
    /** App entry file relative to workdir (e.g. `src/main.tsx`). */
    file: string;
    /** Import line appended to the entry; guarded by `import.meta.env.DEV`. */
    importLine: string;
  };
}

export interface SourceStampPlugin {
  readonly stack: SandboxStack;
  /** Produce the full contribution for this stack's scaffold. */
  contribution(): StampContribution;
}
