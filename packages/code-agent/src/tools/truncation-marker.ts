/**
 * The ONE truncation marker format for model-facing tool output.
 *
 * Telemetry showed six different cut markers across tools (`[truncated, N
 * bytes]`, `[N more lines — …]`, `(limit=N — …)`, `[clamped from …]`,
 * `output_truncated=true`, `[truncated: …]`) — the model can't learn a
 * recovery reflex from six dialects, and the `truncated` telemetry flag
 * (index.ts `isTruncatedOutput`) only matched two of them, so the column
 * under-reported. Every cut now renders as:
 *
 *     [truncated: <detail> — <recovery>]
 *
 * Known exception: `exec_command`/`write_stdin` keep their structured
 * `output_truncated=true` header field (machine-parsed, paired tests);
 * `isTruncatedOutput` matches both shapes.
 *
 * Deterministic by construction — markers land in the transcript and must
 * not destabilize provider prefix caching.
 */
export function truncationMarker(detail: string, recovery?: string): string {
  return `[truncated: ${detail}${recovery ? ` — ${recovery}` : ''}]`;
}
