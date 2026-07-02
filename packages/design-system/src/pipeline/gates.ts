/**
 * Gates determinísticos por etapa — o que `ds_submit_stage` verifica ANTES
 * de mandar a etapa para revisão do usuário. Cada issue nomeia o arquivo e
 * o conserto (o consumidor é o próprio agente). Checks baratos de fs/string;
 * a auditoria profunda (token coverage por literal, a11y, variantes) chega
 * no módulo studio-audit e substitui os checks marcados como "light".
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DsPipelineState, DsStageGateResult, DsStageId } from './stages.js';
import { roadmapProgress, type DsRoadmapTier } from './roadmap.js';
import { THEME_ANALYSIS_DIRNAME, THEME_DIGEST_FILENAME, type ThemeDigest } from '../theme-digest/theme-digest.js';

export interface StageGateInput {
  stage: DsStageId;
  mode: 'fidelity' | 'creative';
  /** Raiz do workspace no host (contém pkg/, app/, import/). */
  workspaceDir: string;
  state: DsPipelineState;
  /** Componentes registrados no draft ∪ última publicada. */
  recorded: Array<{ name: string; kind: string }>;
}

const MIN_BRIEF_CHARS = 800;
const MIN_TOKEN_VARS = 25;
const TIER_COVERAGE: Record<Exclude<DsRoadmapTier, 'template'>, number> = {
  primitive: 0.9,
  composite: 0.85,
};

function readIfExists(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  } catch {
    return null;
  }
}

function readDigest(workspaceDir: string): ThemeDigest | null {
  const raw = readIfExists(join(workspaceDir, 'import', THEME_ANALYSIS_DIRNAME, THEME_DIGEST_FILENAME));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ThemeDigest;
  } catch {
    return null;
  }
}

/** Scan "light" de hex cru em pkg/src/components (o studio-audit aprofunda depois). */
function hexLiteralFiles(componentsDir: string): string[] {
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (/\.(tsx?|jsx?|vue|css|scss)$/.test(entry.name)) {
        const text = readIfExists(abs);
        if (text && /#[0-9a-fA-F]{3,8}\b/.test(text)) offenders.push(abs.slice(componentsDir.length + 1));
      }
    }
  };
  walk(componentsDir);
  return offenders;
}

function tierCoverageIssues(input: StageGateInput, tier: 'primitive' | 'composite'): string[] {
  const items = roadmapProgress(
    input.state.roadmap.filter((item) => item.tier === tier),
    input.recorded.map((c) => c.name),
  );
  if (items.length === 0) return [];
  const done = items.filter((item) => item.recorded);
  const required = Math.ceil(items.length * TIER_COVERAGE[tier]);
  if (done.length >= required) return [];
  const missing = items.filter((item) => !item.recorded).map((item) => item.name);
  return [
    `Roadmap ${tier} coverage is ${done.length}/${items.length} (need ${required}). ` +
      `Missing (build + ds_record_component): ${missing.join(', ')}.`,
  ];
}

export function runStageGate(input: StageGateInput): DsStageGateResult {
  const issues: string[] = [];
  const { workspaceDir } = input;

  switch (input.stage) {
    case 'analysis': {
      const brief = readIfExists(join(workspaceDir, 'DESIGN_BRIEF.md'));
      if (!brief) {
        issues.push('DESIGN_BRIEF.md not found at the workspace root — write it before submitting the analysis stage.');
      } else if (brief.length < MIN_BRIEF_CHARS) {
        issues.push(
          `DESIGN_BRIEF.md has ${brief.length} chars (min ${MIN_BRIEF_CHARS}) — cover palette, typography, shape and the component inventory.`,
        );
      }
      break;
    }
    case 'tokens': {
      const tokens = readIfExists(join(workspaceDir, 'pkg', 'src', 'tokens.css'));
      if (!tokens) {
        issues.push('pkg/src/tokens.css not found.');
        break;
      }
      const varCount = (tokens.match(/--[\w-]+\s*:/g) ?? []).length;
      if (varCount < MIN_TOKEN_VARS) {
        issues.push(`pkg/src/tokens.css declares ${varCount} CSS variables (min ${MIN_TOKEN_VARS}) — a real token set covers colors, typography, radii, spacing and shadows.`);
      }
      const offenders = hexLiteralFiles(join(workspaceDir, 'pkg', 'src', 'components'));
      if (offenders.length > 0) {
        issues.push(
          `Raw hex literals in components (tokens-first violation): ${offenders.join(', ')} — move values into tokens.css and reference var(--…).`,
        );
      }
      if (input.mode === 'fidelity') {
        const digest = readDigest(workspaceDir);
        const top = (digest?.tokens.colors ?? []).slice(0, 10).map((c) => c.hex.toLowerCase());
        if (top.length > 0) {
          const body = tokens.toLowerCase();
          const present = top.filter((hex) => body.includes(hex));
          if (present.length < Math.ceil(top.length * 0.8)) {
            const missing = top.filter((hex) => !body.includes(hex));
            issues.push(
              `Fidelity: only ${present.length}/${top.length} of the theme's top colors appear in tokens.css. ` +
                `Missing (use the digest values verbatim): ${missing.join(', ')}.`,
            );
          }
        }
      }
      break;
    }
    case 'primitives':
      issues.push(...tierCoverageIssues(input, 'primitive'));
      break;
    case 'composites':
      issues.push(...tierCoverageIssues(input, 'composite'));
      break;
    case 'templates': {
      const tier = input.state.roadmap.filter((item) => item.tier === 'template');
      const recordedTemplates = input.recorded.filter((c) => c.kind === 'page-template');
      const required = input.mode === 'fidelity'
        ? Math.ceil(tier.length * 0.9)
        : Math.min(3, Math.max(tier.length, 1));
      if (recordedTemplates.length < required) {
        issues.push(
          `${recordedTemplates.length} page-template component(s) recorded (need ${required}). ` +
            `Roadmap templates: ${tier.map((item) => item.name).join(', ') || '(none)'}.`,
        );
      }
      break;
    }
    case 'docs': {
      const docs = readIfExists(join(workspaceDir, 'pkg', 'docs.md'));
      if (!docs) {
        issues.push('pkg/docs.md not found.');
        break;
      }
      const body = docs.toLowerCase();
      const missing = input.recorded.filter((c) => !body.includes(c.name.toLowerCase())).map((c) => c.name);
      if (missing.length > 0) {
        issues.push(`pkg/docs.md never mentions: ${missing.join(', ')} — every registered component needs a section.`);
      }
      break;
    }
    case 'publish':
      // Sem gate próprio: ds_audit_package + ds_publish_version são o gate.
      break;
  }
  return { ok: issues.length === 0, issues };
}
