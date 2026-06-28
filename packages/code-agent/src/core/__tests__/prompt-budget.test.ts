/**
 * Prompt-budget harness — Fase 0 da redução do system prompt.
 *
 * Renders `buildSystemPrompt` across a representative matrix and asserts
 * per-section CHAR ceilings (baseline + ~10%). Any growth past a ceiling —
 * or a NEW section header not registered here — fails the suite, so prompt
 * bloat becomes a conscious decision instead of drift. Also recreates the
 * cache-boundary guarantees (single boundary, byte-stable static prefix)
 * that previously had no direct coverage.
 *
 * Recalibrating after an INTENTIONAL prompt edit:
 *   PROMPT_BUDGET_REPORT=1 pnpm vitest run prompt-budget
 * prints actual sizes per section/composition; update the maps below and
 * bump SYSTEM_PROMPT_VERSION (core/runner/assembly/system-prompt.ts).
 *
 * Token note: ceilings are in CHARS (deterministic); tokens ≈ chars/4
 * (±15% for code-heavy text). Real-world validation comes from the
 * `system_prompt_chars` column in coder_turn_telemetry.
 */
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildSystemPrompt,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  type PromptContext,
} from '../system-prompt.js';

const REPORT = process.env.PROMPT_BUDGET_REPORT === '1';
/** Report mode dumps measured sizes here (cwd) instead of asserting. */
const REPORT_FILE = '.prompt-budget-report.json';
const reportData: Record<string, unknown> = {};

const BASE_CTX: PromptContext = {
  projectName: 'BudgetProj',
  projectRoot: 'D:/nonexistent-budget-proj',
  os: 'win32',
  providerFamily: 'zai',
  profile: 'navigate',
  mcpAvailable: true,
  isIndexed: true,
  sessionDrive: true,
  agentLoopV2: true,
};

/** First line of base.txt — everything before it is the provider preamble. */
const BASE_INTRO_MARK = 'You work inside MCP IDE';

interface Section { header: string; text: string }

function splitStatic(prompt: string): { preamble: string; sections: Section[] } {
  const boundaryAt = prompt.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
  const staticPrefix = boundaryAt >= 0 ? prompt.slice(0, boundaryAt) : prompt;
  const introAt = staticPrefix.indexOf(BASE_INTRO_MARK);
  const preamble = staticPrefix.slice(0, introAt);
  const rest = staticPrefix.slice(introAt);

  const sections: Section[] = [{ header: '(base-intro)', text: '' }];
  for (const line of rest.split('\n')) {
    if (/^# /.test(line)) sections.push({ header: line.trim(), text: '' });
    const tail = sections[sections.length - 1]!;
    tail.text += (tail.text ? '\n' : '') + line;
  }
  return { preamble, sections };
}

/**
 * Per-section ceilings (chars). Baselines measured 2026-06-12 on the
 * matrix below, +~10% slack. A section not listed here = test failure —
 * register it (with a ceiling) when you intentionally add one.
 */
const SECTION_BUDGETS: Record<string, number> = {
  '(preamble)': 360,
  '(base-intro)': 280,
  '# Project context': 1100,
  '# Tool tiers': 420,
  '# Tool tiers (IMPORTANT)': 720,
  '# Tool strategy — token economy': 1150,
  '# Tool strategy — project NOT indexed': 1010,
  '# Tool strategy — native only (MCP bridge unavailable)': 770,
  '# Native tools (edits, execution, git)': 680,
  '# Images & vision': 500,
  '# Session overlay (automatic freshness)': 730,
  '# Subagents (isolated delegation)': 1120,
  '# Long-term memory': 620, // + memory-staleness caveat (G4)
  '# Memory (session + project)': 1450, // + memory-staleness caveat (G4)
  '# Style': 290,
  // Session-fixed directives (only rendered when configured): language (G1),
  // output style (G8), unsupervised framing (G3).
  '# Language': 420,
  '# Explanatory output': 420,
  '# Learning output': 420,
  '# Operating autonomously': 760,
  '# Plan mode is ACTIVE': 5480, // plan.txt + ## Plan depth block + decision-gate step/section; complex variant ≈ 4974 + ~10%

  '# Explore mode is ACTIVE': 2420,
  '# Build mode is ACTIVE': 2980, // Track G: + pre-execution destructive-action evidence line

  '# Admin mode is ACTIVE': 2450,
  '# Interactive tools': 1020,
  '# Agent loop': 1850, // Track G: + balanced anti-stop (report-vs-fix, reversible-vs-destructive) + plan/spec gate override

  '# Preambles before tool calls': 370,
  '# Do not re-read what you already have': 430,
  '# Active context': 300,
};

/** Whole-composition ceilings for the two canonical shapes (chars). */
const TOTAL_BUDGETS = {
  default: 11500,   // zai · navigate · no plan · no agentId · loop v2 · drive (+ G4 memory-staleness caveat; ~10943 measured)
  planMode: 16100,  // same + specialist plan.txt + ## Plan depth block + decision-gate guidance + Track G agent-loop additions (~15858 measured)
};

interface Composition {
  label: string;
  ctx: PromptContext;
}

const MATRIX: Composition[] = [];
for (const providerFamily of ['anthropic', 'zai'] as const) {
  for (const planMode of [false, true]) {
    for (const agentId of [undefined, 'explore', 'build'] as const) {
      MATRIX.push({
        label: `${providerFamily}|plan=${planMode}|agent=${agentId ?? 'none'}`,
        ctx: { ...BASE_CTX, providerFamily, planMode, agentId },
      });
    }
  }
}
MATRIX.push({ label: 'zai|not-indexed', ctx: { ...BASE_CTX, isIndexed: false } });
MATRIX.push({ label: 'zai|mcp-unavailable', ctx: { ...BASE_CTX, mcpAvailable: false } });
MATRIX.push({ label: 'zai|bootstrap-profile', ctx: { ...BASE_CTX, profile: 'bootstrap' } });
MATRIX.push({ label: 'zai|model-sees-images', ctx: { ...BASE_CTX, modelCanSeeImages: true } });
MATRIX.push({ label: 'zai|company (no drive)', ctx: { ...BASE_CTX, sessionDrive: false } });
// Plan-depth variants (migration 151): `complex` is the longest plan-section
// payload, so it sets the "# Plan mode is ACTIVE" ceiling.
MATRIX.push({ label: 'zai|plan=true|depth=complex', ctx: { ...BASE_CTX, planMode: true, planDepth: 'complex' } });
// Session-fixed directive variants: language (G1), output style (G8),
// unsupervised framing (G3). Each adds one section above the boundary.
MATRIX.push({ label: 'zai|lang=pt-BR', ctx: { ...BASE_CTX, responseLanguage: 'Português (Brasil)' } });
MATRIX.push({ label: 'zai|style=explanatory', ctx: { ...BASE_CTX, outputStyle: 'explanatory' } });
MATRIX.push({ label: 'zai|style=learning', ctx: { ...BASE_CTX, outputStyle: 'learning' } });
MATRIX.push({ label: 'zai|unsupervised', ctx: { ...BASE_CTX, unsupervised: true } });

describe('prompt-budget — per-section ceilings', () => {
  it('every section is registered and within budget across the matrix', () => {
    const report: Record<string, Record<string, number>> = {};
    for (const { label, ctx } of MATRIX) {
      const prompt = buildSystemPrompt(ctx);
      const { preamble, sections } = splitStatic(prompt);
      const sizes: Record<string, number> = { '(preamble)': preamble.length };
      for (const s of sections) {
        sizes[s.header] = (sizes[s.header] ?? 0) + s.text.length;
      }
      report[label] = sizes;
      if (REPORT) continue;
      for (const [header, size] of Object.entries(sizes)) {
        const budget = SECTION_BUDGETS[header];
        expect(budget, `unregistered prompt section "${header}" (in ${label}) — add it to SECTION_BUDGETS with a ceiling`).toBeDefined();
        expect(size, `section "${header}" grew past its ${budget}-char ceiling (${size} chars, in ${label})`).toBeLessThanOrEqual(budget!);
      }
    }
    if (REPORT) {
      reportData.sections = report;
      writeFileSync(REPORT_FILE, JSON.stringify(reportData, null, 2));
    }
  });

  it('canonical compositions stay under their total ceilings', () => {
    const prefixOf = (ctx: PromptContext): string =>
      buildSystemPrompt(ctx).split(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)[0]!;
    const def = prefixOf(BASE_CTX).length;
    const plan = prefixOf({ ...BASE_CTX, planMode: true }).length;
    if (REPORT) {
      reportData.totals = { totalDefault: def, totalPlanMode: plan };
      writeFileSync(REPORT_FILE, JSON.stringify(reportData, null, 2));
      return;
    }
    expect(def, `default static prefix ${def} chars > ${TOTAL_BUDGETS.default}`).toBeLessThanOrEqual(TOTAL_BUDGETS.default);
    expect(plan, `plan-mode static prefix ${plan} chars > ${TOTAL_BUDGETS.planMode}`).toBeLessThanOrEqual(TOTAL_BUDGETS.planMode);
  });
});

describe('prompt-budget — cache boundary guarantees', () => {
  it('the boundary marker appears exactly once in every composition', () => {
    for (const { label, ctx } of MATRIX) {
      const prompt = buildSystemPrompt(ctx);
      const count = prompt.split(SYSTEM_PROMPT_DYNAMIC_BOUNDARY).length - 1;
      expect(count, `boundary count in ${label}`).toBe(1);
    }
  });

  it('static prefix is byte-identical when only dynamic inputs change', () => {
    const prefix = (ctx: PromptContext): string =>
      buildSystemPrompt(ctx).split(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)[0]!;
    const bare = prefix(BASE_CTX);
    expect(prefix({ ...BASE_CTX, toolCap: { maxTools: 32, approxCatalog: 137 } })).toBe(bare);
    expect(prefix({
      ...BASE_CTX,
      customTiers: [{ tier: 'cf', displayName: 'Cloudflare', toolCount: 9 }],
    })).toBe(bare);
    expect(prefix({ ...BASE_CTX, repoMap: '# Repo map\n- a.ts: foo()' })).toBe(bare);
  });

  it('toolCap and customTiers render BELOW the boundary', () => {
    const prompt = buildSystemPrompt({
      ...BASE_CTX,
      toolCap: { maxTools: 32, approxCatalog: 137 },
      customTiers: [{ tier: 'cf', displayName: 'Cloudflare', toolCount: 9 }],
    });
    const [staticPrefix, dynamicSuffix] = prompt.split(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    expect(staticPrefix).not.toContain('# Tool visibility (model-adapted)');
    expect(staticPrefix).not.toContain('# External tool groups');
    expect(dynamicSuffix).toContain('# Tool visibility (model-adapted)');
    expect(dynamicSuffix).toContain('# External tool groups (hidden, on-demand)');
  });
});

describe('session-fixed directive gating (G1 language / G8 style / G3 autonomous)', () => {
  it('language block renders only when a concrete language is set', () => {
    expect(buildSystemPrompt(BASE_CTX)).not.toContain('# Language');
    expect(buildSystemPrompt({ ...BASE_CTX, responseLanguage: 'auto' })).not.toContain('# Language');
    const pt = buildSystemPrompt({ ...BASE_CTX, responseLanguage: 'Português (Brasil)' });
    expect(pt).toContain('# Language');
    expect(pt).toContain('Português (Brasil)');
  });

  it('output-style block reflects the selected style', () => {
    expect(buildSystemPrompt(BASE_CTX)).not.toContain('# Explanatory output');
    expect(buildSystemPrompt({ ...BASE_CTX, outputStyle: 'proactive' })).not.toContain('# Explanatory output');
    expect(buildSystemPrompt({ ...BASE_CTX, outputStyle: 'explanatory' })).toContain('# Explanatory output');
    expect(buildSystemPrompt({ ...BASE_CTX, outputStyle: 'learning' })).toContain('# Learning output');
  });

  it('autonomous block renders only when unsupervised', () => {
    expect(buildSystemPrompt(BASE_CTX)).not.toContain('# Operating autonomously');
    expect(buildSystemPrompt({ ...BASE_CTX, unsupervised: true })).toContain('# Operating autonomously');
  });

  it('suppresses the learning hand-off under unsupervised (no TODO(human) with no human)', () => {
    const p = buildSystemPrompt({ ...BASE_CTX, unsupervised: true, outputStyle: 'learning' });
    expect(p).toContain('# Operating autonomously');
    expect(p).not.toContain('# Learning output');
  });
});
