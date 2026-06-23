/**
 * Command-synth safety layer — the ONLY gate between a sintetizer's
 * output (AI or deterministic) and `LocalShellAdapter.spawn()`.
 *
 * Philosophy: default-deny. We enumerate every program we're willing
 * to run as host process for a local project, and we block a small set
 * of argv flags that turn "run this dev server" into "execute arbitrary
 * code" (`node -e`, `python -c`, `bash -c`).
 *
 * Why flag-level blocking when we already gate the program name?
 *   Because `npx` is on the allowlist (it's the canonical way to run
 *   `vite`), but `npx -p evil-package -c 'malicious'` would be
 *   equivalent to `sh -c`. Same for `node --eval`.
 */

export const ALLOWED_PROGRAMS: ReadonlySet<string> = new Set([
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'node',
  'python',
  'python3',
  'uvicorn',
  'flask',
  'gunicorn',
  'go',
  'cargo',
  'ruby',
  'bundle',
  'rails',
]);

/**
 * Argv flags rejected outright, regardless of program. These accept
 * arbitrary code via the next argument (`-c "rm -rf ~"`). The
 * ecosystem equivalents are all here: node/python/ruby each have
 * `-e` or `-c`; `bundle exec` is fine because `exec` is not a flag.
 *
 * `--eval` and `--exec` are the long forms across ecosystems. Anything
 * that *starts* with one of these is treated as a match, so `-e=code`
 * and `-e code` both trip.
 */
const BANNED_FLAG_PREFIXES = [
  '-c',
  '-e',
  '--eval',
  '--exec',
  '--command',
] as const;

export interface ValidateArgvResult {
  ok: boolean;
  /** Set when `ok=false`. Human-readable and safe to surface to the UI. */
  reason?: string;
}

/**
 * Validate a synthesized command. Returns `{ ok: true }` when the program
 * is on the allowlist AND no argv entry matches a banned flag prefix.
 *
 * Note: we intentionally do NOT try to parse argv — a sinister value
 * might hide behind `=` or quoting. We reject on prefix match, which
 * is conservative. False positives (e.g. a tool accepting `-c` as a
 * "config path") are rare in dev-server ecosystems and can be handled
 * by the fallback-rules layer (which never emits these flags).
 */
export function validateArgv(program: string, args: readonly string[]): ValidateArgvResult {
  if (typeof program !== 'string' || program.length === 0) {
    return { ok: false, reason: 'program must be a non-empty string' };
  }
  if (program.includes('/') || program.includes('\\')) {
    return {
      ok: false,
      reason: `program '${program}' must be a bare executable name, not a path`,
    };
  }
  if (!ALLOWED_PROGRAMS.has(program)) {
    return { ok: false, reason: `program '${program}' is not on the allowlist` };
  }
  for (const arg of args) {
    if (typeof arg !== 'string') {
      return { ok: false, reason: 'all argv entries must be strings' };
    }
    for (const banned of BANNED_FLAG_PREFIXES) {
      if (arg === banned || arg.startsWith(banned + '=')) {
        return { ok: false, reason: `argv flag '${arg}' is banned (arbitrary-code risk)` };
      }
    }
  }
  return { ok: true };
}
