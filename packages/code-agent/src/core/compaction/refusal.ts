import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import { extractReadPreview, findToolResultByUseId } from './elision.js';

export interface RichRefusalArgs {
  toolName: string;
  path: string;
  prior: Array<{ turn: number; useId: string; mtimeMs?: number }>;
  windowTurns: number;
  currentMtimeMs?: number;
  /** Preview of the FIRST prior read, if its tool_result is still in context. */
  contextPreview?: { headLines: string[]; tailLines: string[]; totalLines: number };
  /** Symbols glimpsed earlier (from a skeleton in the same window), if any. */
  knownSymbols?: Array<{ name: string; line: number; kind: string }>;
}

/**
 * Build the compact refusal payload for the pre-dispatch read-dedup cap.
 *
 * Deterministic over the input args (no Date.now / randomness) because it
 * becomes part of the tool_result that feeds back into the provider prompt —
 * non-determinism would break prefix caching.
 *
 * Design note (token budget): a previous revision emitted ~1500 chars. For
 * small reads (e.g. 250-char file slices), the refusal was 6× larger than the
 * content it was preventing — the brake cost more tokens than the loop. This
 * version drops the verbose lists and renders as 2–3 lines (~250 chars).
 * Optional fields (`currentMtimeMs`, `contextPreview`, `knownSymbols`) are
 * kept on the signature for backwards-compat but not rendered.
 */
export function buildRichRefusal(args: RichRefusalArgs): string {
  const { toolName, path, prior, windowTurns } = args;
  // Compact turn list — just the numbers, joined comma-sep.
  const turns = prior.map((p) => p.turn).join(', ');
  const plural = prior.length === 1 ? '' : 's';

  return (
    `Refused: \`${toolName}\` called ${prior.length} time${plural} for \`${path}\` ` +
    `in last ${windowTurns} turns (turn${plural} ${turns}). ` +
    `Content is already in your context above — quote it and act on it, ` +
    `or pass \`force_reread: true\` if the file genuinely changed since the first read.`
  );
}

/**
 * Opt-in auto-downgrade response: instead of refusing outright, return a
 * skeleton-flavoured pointer to the prior read. Marked clearly so the model
 * understands this is NOT a fresh fetch. Deterministic over inputs.
 */
export function buildAutoDowngradeResponse(
  toolName: string,
  path: string,
  prior: Array<{ turn: number; useId: string }>,
  windowTurns: number,
  messages: AgentMessage[],
): string {
  const lines: string[] = [];
  lines.push(
    `[auto-downgraded from ${toolName}] You already read \`${path}\` in the last ${windowTurns} turns ` +
    `(${prior.length}× — see turn${prior.length === 1 ? '' : 's'} ${prior.map((p) => p.turn).join(', ')}). ` +
    `The runner is returning a pointer instead of re-fetching the content.`,
  );
  // Try to surface the most useful prior read still in context.
  for (const p of prior) {
    const r = findToolResultByUseId(p.useId, messages);
    if (r && !r.isElided) {
      const preview = extractReadPreview(r.content, 4, 2);
      lines.push('');
      lines.push(`Prior read at turn ${p.turn} (tool_use ${p.useId}) — ${preview.totalLines} lines:`);
      for (const l of preview.headLines) lines.push(`  ${l}`);
      if (preview.tailLines.length > 0) {
        lines.push('  ...');
        for (const l of preview.tailLines) lines.push(`  ${l}`);
      }
      break;
    }
  }
  lines.push('');
  lines.push(
    'If you need a region you have not read yet, change `start_line`/`end_line` or pass another `symbol`. ' +
    'If you need an outline, call `mcp__get_file_skeleton`. If you only need callers, call `mcp__find_references`.',
  );
  return lines.join('\n');
}
