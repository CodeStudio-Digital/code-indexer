/**
 * Command-synth shared types — the contract between the synthesizer
 * (AI or deterministic fallback) and the `LocalProcessManager`.
 *
 * A `SynthesizedCommand` must survive the allowlist/validator before
 * being handed to `LocalShellAdapter.spawn()`.
 */

export interface ReadinessProbe {
  /** HTTP GET probe: poll `path` until non-5xx reply (or timeout). */
  kind: 'http';
  /** URL path starting with '/'. Host/port are injected by the manager. */
  path: string;
}

export interface SynthesizedCommand {
  /** Bare executable name (no path separators). Must be on the allowlist. */
  program: string;
  /** Fully-parsed argv. No shell metacharacters interpreted. */
  args: string[];
  /**
   * Env vars to pass to the child. `PORT` is added by the manager —
   * synthesizers may also set it (redundantly) so the value reaches
   * tools that honor it over argv.
   */
  env: Record<string, string>;
  /** How to decide "the server is up" after spawn. */
  readyProbe: ReadinessProbe;
  /**
   * Free-text note about what the synthesizer chose and why. Not load-
   * bearing — shown in the UI so the user understands the command.
   */
  rationale: string;
}
