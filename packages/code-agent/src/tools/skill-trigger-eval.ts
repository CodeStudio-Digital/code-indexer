/**
 * Deterministic trigger evaluation for `create_skill`.
 *
 * A skill auto-loads into the system prompt only when the matcher
 * (`skill-matcher.ts`) fires on a session context — and the matcher reads
 * ONLY `role` / `tags` / `paths` signals, never natural language. So the
 * single most common authoring mistake is a trigger that never (or always)
 * fires. This helper simulates the matcher against synthetic contexts built
 * from the new skill's own triggers and reports two things:
 *
 *   1. Does the new skill actually fire on its declared triggers?
 *   2. Which OTHER skills fire on the same contexts (collisions)?
 *
 * It's a pure function over `ResolvedSkill[]` so the tool layer (which owns
 * the SkillStore) stays thin and this stays unit-testable.
 */
import { minimatch } from 'minimatch';
import { matchSkills, type SkillMatchContext } from '@mcp/code-agent/skills/skill-matcher.js';
import type { ResolvedSkill } from '@mcp/code-agent/skills/types.js';

export interface TriggerContextResult {
  /** Human label for the synthetic context, e.g. `path:src/**\/*.ts`. */
  label: string;
  /** Synthetic context fed to the matcher. */
  context: SkillMatchContext;
  /** Did the candidate skill fire (confidence >= threshold)? */
  candidateFired: boolean;
  candidateConfidence: number | null;
  /** Other skills that fired on the same context (id + confidence + reason). */
  collisions: Array<{ id: string; confidence: number; reason: string }>;
}

export interface TriggerEvalReport {
  /** True when the skill declares no auto-triggers (discovery-only). */
  discoveryOnly: boolean;
  /** True when the candidate fired on at least one of its own contexts. */
  fires: boolean;
  results: TriggerContextResult[];
  /** Compact human-readable lines for the tool result. */
  summary: string[];
}

/**
 * Turn a glob into a concrete sample path the matcher can test. `matchBase`
 * is on in the matcher, so a bare `*.ts` matches any basename. We expand the
 * common wildcards and verify the result actually matches the source glob;
 * if it doesn't (exotic pattern), we return null so the caller can flag it.
 */
function synthPathForGlob(glob: string): string | null {
  const candidate = glob
    .replace(/\*\*\//g, 'sample/')
    .replace(/\*\*/g, 'sample')
    .replace(/\*/g, 'sample')
    .replace(/\{[^}]*\}/g, 'sample')
    .replace(/\?/g, 'a');
  return minimatch(candidate, glob, { matchBase: true, nocase: false }) ? candidate : null;
}

export function evalSkillTriggers(
  candidate: ResolvedSkill,
  existing: ResolvedSkill[],
): TriggerEvalReport {
  // Evaluate against the catalog WITH the candidate included so the matcher
  // ranks them together exactly as it would at runtime.
  const all = [...existing.filter((s) => s.id !== candidate.id), candidate];
  const THRESHOLD = 0.5;

  const contexts: Array<{ label: string; ctx: SkillMatchContext }> = [];
  for (const role of candidate.triggerRoles ?? []) {
    contexts.push({ label: `role:${role}`, ctx: { role } });
  }
  for (const tag of candidate.triggerTags ?? []) {
    contexts.push({ label: `tag:${tag}`, ctx: { sessionTags: [tag] } });
  }
  for (const glob of candidate.triggerPaths ?? []) {
    const file = synthPathForGlob(glob);
    if (file) contexts.push({ label: `path:${glob}`, ctx: { recentFiles: [file] } });
    else contexts.push({ label: `path:${glob} (unsynthesizable)`, ctx: {} });
  }

  const results: TriggerContextResult[] = [];
  const summary: string[] = [];

  if (contexts.length === 0) {
    return {
      discoveryOnly: true,
      fires: false,
      results: [],
      summary: [
        'No auto-triggers declared — this skill is discovery-only (surfaced via get_skills_list / slash command).',
        'It will only auto-load if you add trigger_roles / trigger_tags / trigger_paths. Make the description discriminating so the agent picks it from the catalog.',
      ],
    };
  }

  let firedAny = false;
  for (const { label, ctx } of contexts) {
    const matched = matchSkills(all, ctx, { threshold: THRESHOLD, topK: 20 });
    const mine = matched.find((m) => m.id === candidate.id);
    const candidateFired = !!mine;
    if (candidateFired) firedAny = true;
    const collisions = matched
      .filter((m) => m.id !== candidate.id)
      .map((m) => ({ id: m.id, confidence: m.matchConfidence, reason: m.matchReason }));
    results.push({
      label,
      context: ctx,
      candidateFired,
      candidateConfidence: mine?.matchConfidence ?? null,
      collisions,
    });
    const collisionNote = collisions.length
      ? ` ⚠ also fires: ${collisions.map((c) => c.id).join(', ')}`
      : '';
    summary.push(
      `${candidateFired ? '✓' : '✗'} ${label} → ${
        candidateFired ? `fires (conf ${mine!.matchConfidence})` : 'does NOT fire'
      }${collisionNote}`,
    );
  }

  if (!firedAny) {
    summary.push('⚠ The skill did not fire on ANY of its declared triggers — check the glob/role/tag values.');
  }

  return { discoveryOnly: false, fires: firedAny, results, summary };
}
