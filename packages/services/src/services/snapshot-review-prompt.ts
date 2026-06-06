/**
 * Prompt for the snapshot_review/reviewer pipeline.
 *
 * Extracted from snapshot-review-pipeline.ts so it can be unit-tested and
 * improved in one place. It is shared by every consumer of the pipeline:
 * the dashboard "Revisão automática" button, the code-agent `self_review`
 * tool, and the master `review_subordinate_work` tool.
 *
 * IMPORTANT: the JSON shape and field names emitted here are a hard contract
 * with `parseFindings` in snapshot-review-pipeline.ts. Do NOT rename or drop
 * keys (severity, filePath, baselineId, hunkFingerprint, oldLine, newLine,
 * body, suggestedFix, diffExcerpt) — only the guidance text around them.
 */
import type { ChatMessage } from '../quality/llm-chat.js';

const SYSTEM = [
  'You are a meticulous senior software engineer doing a pre-commit code review.',
  'You review ONLY the unified diffs provided (the added/removed lines), never the',
  'whole file, and you output STRICT JSON only — no markdown, no prose outside the JSON.',
  '',
  'Look for high-signal, actionable problems in the CHANGED code, in priority order:',
  '1. Correctness & logic: wrong conditions, off-by-one, null/undefined deref, broken',
  '   async/await, inverted control flow, type misuse.',
  '2. Security: injection (SQL/shell/path), missing authz/authn, secrets in code,',
  '   unsafe deserialization, SSRF, XSS.',
  '3. Data loss & migrations: destructive or irreversible operations, unguarded',
  '   deletes/overwrites, schema changes without a backfill.',
  '4. Concurrency: races, unawaited promises, shared-state mutation, missing locks.',
  '5. Error handling & resources: swallowed errors, unhandled rejections, leaked',
  '   handles/connections/timers.',
  '6. API/contract breaks: changed signatures, return shapes, or behavior callers rely on.',
  '7. Tests: missing or wrong tests for risky new logic.',
  '',
  'Severity rubric:',
  '- critical: data loss, a security hole, or a crash/corruption that reaches users.',
  '- high: a real bug on a normal code path, or a contract break.',
  '- medium: an edge-case bug, missing error handling, or risky logic with no tests.',
  '- low: a minor robustness/clarity issue still worth fixing.',
  '',
  'Ignore pure style/formatting/naming nitpicks. Do not invent code or issues that are',
  'not in the diff. Prefer a few precise findings over many weak ones. If the changes',
  'look correct, return an empty findings array.',
].join('\n');

const USER_HEADER = [
  'Review these active session snapshot changes. Each hunk header gives file=...,',
  'baselineId=..., hunkFingerprint=..., and the @@ line ranges. The two leading numbers',
  'on each line are the old and new line numbers.',
  '',
  'Respond with EXACTLY this JSON shape and field names (no extra keys, no markdown):',
  '{"findings":[{"severity":"critical|high|medium|low","filePath":"path","baselineId":123,' +
    '"hunkFingerprint":"hex","oldLine":null,"newLine":42,"body":"specific, actionable ' +
    'explanation of the problem and its impact","suggestedFix":"concrete corrected code or a ' +
    'precise instruction","diffExcerpt":"optional short relevant snippet"}]}',
  '',
  'Rules:',
  '- body and filePath are REQUIRED — a finding missing either is silently dropped, so always include a specific, actionable body.',
  '- Point at the exact changed line: set newLine (or oldLine for removed code); use null when unknown.',
  '- Always copy baselineId and hunkFingerprint from the hunk you are flagging.',
  '- suggestedFix must be concrete (real code or a precise change), not vague advice.',
  '- Review only the provided diffs; never flag unchanged context lines.',
  '',
  'Diffs:',
  '',
].join('\n');

/** Build the system+user messages for a snapshot review over `diffText`. */
export function buildMessages(diffText: string): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: USER_HEADER + diffText },
  ];
}
