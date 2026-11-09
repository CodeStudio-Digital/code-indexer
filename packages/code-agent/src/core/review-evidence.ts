/**
 * Verification-evidence auditor for self_review (Onda 1c).
 *
 * The reviewer used to receive whatever the agent CLAIMED about tests
 * ("testSummary" strings). This module replaces claims with the recorded
 * timeline the session bundle already owns: tool-call output metadata crossed
 * with the baseline edit envelopes. The product is a small, factual
 * block: which verify-ish commands actually ran, how they exited, and which
 * files were edited AFTER the last run — i.e. whether the evidence is stale.
 *
 * Read-only over the filesystem session repository; every failure degrades to `null`
 * (the review simply runs without the section).
 */
import type { SessionId } from '@mcp/session-storage';
import type { FsReviewEvidenceSource } from '../sessions/fs-store/review-evidence-repository.js';
import { extractValidationSignal } from './tool-call-ledger.js';

export interface VerifyCommandRecord {
  command: string;
  at: string;
  isError: boolean;
  exitCode: number | null;
}

export interface VerifyEvidence {
  /** Most recent verify-ish command, if any ran this session. */
  lastVerify: VerifyCommandRecord | null;
  /** Total verify-ish runs recorded this session. */
  verifyCount: number;
  /** Files edited AFTER the last verify run (evidence staleness). */
  filesEditedAfter: string[];
  /**
   * Files edited at the SAME persisted timestamp as the last verify. The
   * envelope timestamps cannot prove ordering inside that instant, so
   * completion logic must treat this as ambiguous rather than silently fresh.
   */
  filesEditedAtSameTime?: string[];
}

const MAX_EDITED_FILES = 12;
const MAX_COMMAND_CHARS = 160;

function commandOf(argsJson: string): string | null {
  try {
    const args = JSON.parse(argsJson) as Record<string, unknown>;
    const cmd = args.command ?? args.cmd;
    return typeof cmd === 'string' && cmd.trim() ? cmd.trim() : null;
  } catch {
    return null;
  }
}

/** exec_command reports `exit=N` in its result; run_command "exit code N". */
function exitCodeOf(resultText: string | null): number | null {
  if (!resultText) return null;
  const lines = resultText.split(/\r?\n/, 3);
  // Parse native headers, never exit-looking stdout from a still-live shell.
  const receipt = lines[0]?.startsWith('session_id=') ? lines[0]
    : lines[0]?.startsWith('$ ') ? lines[1] ?? '' : resultText;
  const m = /\bexit(?:\s+code)?\s*[:=]?\s*(-?\d+)\b/i.exec(receipt);
  return m ? Number(m[1]) : null;
}

export async function buildVerifyEvidence(
  source: FsReviewEvidenceSource,
  sessionId: SessionId | string,
): Promise<VerifyEvidence | null> {
  try {
    const rows = await source.listReviewEvidenceToolCalls(sessionId, 200);

    const verifies: VerifyCommandRecord[] = [];
    for (const row of rows) {
      const command = commandOf(row.args_json);
      if (!command || !extractValidationSignal('run_command', JSON.parse(row.args_json))) continue;
      verifies.push({
        command: command.slice(0, MAX_COMMAND_CHARS),
        at: row.created_at,
        isError: row.is_error === 1,
        exitCode: exitCodeOf(row.result_text),
      });
    }
    const lastVerify = verifies[0] ?? null;

    let filesEditedAfter: string[] = [];
    let filesEditedAtSameTime: string[] = [];
    if (lastVerify) {
      const edits = (await source.listReviewEvidenceEdits(sessionId))
        .filter((row) => row.applied_at >= lastVerify.at)
        .sort((left, right) => left.file_path.localeCompare(right.file_path))
        .slice(0, MAX_EDITED_FILES + 1);
      filesEditedAfter = edits
        .filter((row) => row.applied_at > lastVerify.at)
        .map((row) => row.file_path);
      filesEditedAtSameTime = edits
        .filter((row) => row.applied_at === lastVerify.at)
        .map((row) => row.file_path);
    }
    return {
      lastVerify,
      verifyCount: verifies.length,
      filesEditedAfter,
      filesEditedAtSameTime,
    };
  } catch {
    return null;
  }
}

/** Render the evidence block for the reviewer prompt (context subsection). */
export function formatVerifyEvidence(e: VerifyEvidence): string {
  if (!e.lastVerify) {
    return 'No test/typecheck/lint/build command was recorded this session — the changes below are UNVERIFIED.';
  }
  const { lastVerify } = e;
  const outcome =
    lastVerify.exitCode != null
      ? `exit=${lastVerify.exitCode}`
      : lastVerify.isError
        ? 'failed'
        : 'completion unknown';
  const lines = [
    `Last verify run: \`${lastVerify.command}\` at ${lastVerify.at} (${outcome}); ${e.verifyCount} verify run(s) recorded this session.`,
  ];
  if (lastVerify.isError || (lastVerify.exitCode != null && lastVerify.exitCode !== 0)) {
    lines.push('FAILED: the latest validation did not pass; do not report the changes as verified.');
  } else if (lastVerify.exitCode == null) {
    lines.push('AMBIGUOUS: no successful terminal exit was recorded; wait for completion or rerun verification.');
  }
  if (e.filesEditedAfter.length > 0) {
    const shown = e.filesEditedAfter.slice(0, MAX_EDITED_FILES);
    const more = e.filesEditedAfter.length > MAX_EDITED_FILES ? ' (+more)' : '';
    lines.push(
      `STALE: edited AFTER that run — ${shown.join(', ')}${more}. The recorded result does not cover these edits.`,
    );
  } else if ((e.filesEditedAtSameTime?.length ?? 0) > 0) {
    const shown = e.filesEditedAtSameTime!.slice(0, MAX_EDITED_FILES);
    const more = e.filesEditedAtSameTime!.length > MAX_EDITED_FILES ? ' (+more)' : '';
    lines.push(
      `AMBIGUOUS: edited in the SAME persisted second — ${shown.join(', ')}${more}. Ordering cannot be proven; rerun verification.`,
    );
  } else if (!lastVerify.isError && lastVerify.exitCode === 0) {
    lines.push('No edits recorded after that run — the result covers the current state.');
  }
  return lines.join('\n');
}
