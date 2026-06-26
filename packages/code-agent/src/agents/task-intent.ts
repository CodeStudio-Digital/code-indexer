/**
 * Deterministic task-intent classifier (Phase 1 of the code-agent rework).
 *
 * Maps a free-form user message to a {@link TaskIntent} using ordered keyword
 * rules. It is intentionally rule-based (no LLM) so it is:
 *   - fast and free (runs on every turn with zero token cost);
 *   - deterministic (unit-testable, reproducible in shadow logs);
 *   - bilingual (the project's prompts/heuristics already mix EN + PT-BR —
 *     see inferProfileFromMessage in tools/tiers.ts).
 *
 * Rules are evaluated in priority order: the FIRST matching rule wins. Order
 * matters — higher-risk / more-specific intents (git_admin, diagram, api) are
 * checked before generic edit/answer so e.g. "commit the fix" classifies as
 * git_admin, not edit.
 *
 * When nothing matches we fall back to 'answer' (the cheapest, safest intent),
 * with low confidence so callers can treat it as "unsure".
 */
import type { IntentClassification, TaskIntent } from '@mcp/code-agent/agents/decision-types.js';

interface IntentRule {
  intent: TaskIntent;
  /** Regex over the lowercased message. */
  pattern: RegExp;
  /** Confidence assigned on match, in [0, 1]. */
  confidence: number;
}

/**
 * Ordered rules — FIRST match wins. Keep the most specific / highest-risk
 * intents at the top. Patterns are matched against `message.toLowerCase()`.
 */
const INTENT_RULES: readonly IntentRule[] = [
  // git / admin — highest priority so "commit the fix" is NOT just an edit.
  {
    intent: 'git_admin',
    pattern:
      /\b(commit|push|pull request|\bpr\b|branch|checkout|rebase|merge|cherry-?pick|stash|tag|release|revert|reset --hard|force[- ]?push|deploy|publish (the )?(package|version|release))\b/,
    confidence: 0.9,
  },
  // diagram authoring — before edit ("create"/"draw" overlap).
  {
    intent: 'diagram',
    pattern:
      /\b(diagram|draw\.?io|flowchart|fluxograma|sequence diagram|er diagram|c4 (model|diagram)|architecture diagram)\b/,
    confidence: 0.85,
  },
  // OpenAPI / Swagger collection authoring & verification — before edit.
  {
    intent: 'api_collection',
    pattern: /\b(openapi|swagger|api collection|api reference|endpoint(s)? (spec|verification)|postman)\b/,
    confidence: 0.85,
  },
  // UI / live-preview work.
  {
    intent: 'preview',
    pattern:
      /\b(preview|screenshot|live app|dev ?server|render(ing|ed|s)?|tailwind|shadcn|component (looks|renders)|ui bug|layout|responsive)\b/,
    confidence: 0.7,
  },
  // External documentation lookup. Tightened: bare "docs"/"documentation"
  // is too broad ("update the docs" is an EDIT), so require a lookup context.
  {
    intent: 'external_docs',
    pattern:
      /\b(read the docs|official docs|docs? for\b|documentation (for|of|on)\b|how to use .* (library|framework|package|sdk)|look up .* (docs|documentation))\b/,
    confidence: 0.6,
  },
  // verification — run tests / typecheck / build / lint. "build" is matched
  // ONLY in verify contexts (run build / npm build / build the project) so
  // "build the feature" stays an edit below.
  {
    intent: 'verify',
    pattern:
      /\b(run (the )?tests?|test suite|typecheck|type-?check|\btsc\b|\blint\b|\bcompile\b|verify|npm (run )?(test|build|typecheck)|pnpm (run )?(test|typecheck|build)|cargo (build|test)|run (the )?build|rebuild|build the project)\b/,
    confidence: 0.75,
  },
  // planning — design / approach before changing. "plan a refactor" → plan,
  // while a bare "refactor" → edit (below).
  {
    intent: 'plan',
    pattern:
      /\b(plan|planeje|plano|design (a|the)|approach|strategy|estrat(e|é)gia|architect (a|the)|roadmap|how should (i|we)|propose)\b/,
    confidence: 0.65,
  },
  // edit — implement / fix / refactor / add / remove. Bilingual, mirrors
  // inferProfileFromMessage so routing stays consistent with tiering.
  {
    intent: 'edit',
    pattern:
      /\b(implement|implemente|fix|corrij(a|e)|refactor|refatore|add\b|adicione|create|crie|write|escreva|edit|edite|update|atualize|rename|renomeie|move|mova|delete|remove|remova|change|mude|altere|wire up|hook up|build (a|the) (feature|component|function))\b/,
    confidence: 0.7,
  },
  // locate — find / where is / search.
  {
    intent: 'locate',
    pattern:
      /\b(find|where (is|are|does)|locate|search for|onde (est(a|á)|fica)|encontre|procure|which file|what file|list (all )?(the )?(files|usages|references))\b/,
    confidence: 0.65,
  },
  // answer — explain / what / why / how does X work.
  {
    intent: 'answer',
    pattern:
      /\b(explain|explique|what (is|are|does)|o que (e|é|faz)|why|por ?qu(e|ê)|how does|como funciona|describe|descreva|summarize|resuma|tell me about)\b/,
    confidence: 0.6,
  },
];

/**
 * Classify the user message into a {@link TaskIntent}. Pure & deterministic.
 *
 * @param message Raw user message (any language). Empty/whitespace → low-conf
 *   'answer'.
 */
export function classifyIntent(message: string): IntentClassification {
  const lower = (message ?? '').toLowerCase();
  if (lower.trim().length === 0) {
    return { intent: 'answer', confidence: 0.2, matched: [] };
  }

  for (const rule of INTENT_RULES) {
    const m = lower.match(rule.pattern);
    if (m) {
      return {
        intent: rule.intent,
        confidence: rule.confidence,
        matched: [m[0]],
      };
    }
  }

  // Nothing matched — default to the cheapest, safest intent with low
  // confidence so the engine treats it as "unsure" and stays conservative.
  return { intent: 'answer', confidence: 0.25, matched: [] };
}
