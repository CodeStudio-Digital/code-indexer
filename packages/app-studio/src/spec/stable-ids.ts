import type { AppSpec } from './types.js';
import { kebab } from './names.js';

export type AppRequirementKind = 'goal' | 'rule' | 'acceptance' | 'out-of-scope' | 'assumption' | 'risk';

function stableId(kind: AppRequirementKind, text: string): string {
  const slug = kebab(text).slice(0, 36) || 'item';
  const input = `${kind}:${text.trim().toLowerCase()}`;
  let value = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    value ^= input.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  const hash = (value >>> 0).toString(16).padStart(8, '0');
  return `${kind}:${slug}:${hash}`;
}

function uniqueIds(kind: AppRequirementKind, values: string[], explicit: string[] | undefined): string[] {
  const used = new Set<string>();
  return values.map((text, index) => {
    const base = explicit?.[index] || stableId(kind, text);
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) candidate = `${base}:${suffix++}`;
    used.add(candidate);
    return candidate;
  });
}

export function stableRequirementSourceIds(spec: AppSpec, kind: AppRequirementKind): string[] {
  const values = kind === 'goal' ? spec.requirements?.goals
    : kind === 'rule' ? spec.requirements?.business_rules
      : kind === 'acceptance' ? spec.requirements?.acceptance_criteria
        : kind === 'out-of-scope' ? spec.requirements?.out_of_scope
          : kind === 'assumption' ? spec.requirements?.assumptions
            : spec.requirements?.risks;
  if (spec.v === 1) {
    const legacyPrefix = kind === 'acceptance' ? 'acceptance' : kind;
    return (values ?? []).map((_, index) => `${legacyPrefix}:${index}`);
  }
  return uniqueIds(kind, values ?? [], spec.requirement_ids?.[kind]);
}

export function upgradeAppSpecToV2(spec: AppSpec): AppSpec {
  const ids = spec.requirement_ids ?? {};
  const fill = (kind: AppRequirementKind, values: string[]): string[] => uniqueIds(kind, values, ids[kind]);
  return {
    ...spec,
    v: 2,
    requirement_ids: {
      goal: fill('goal', spec.requirements?.goals ?? []),
      rule: fill('rule', spec.requirements?.business_rules ?? []),
      acceptance: fill('acceptance', spec.requirements?.acceptance_criteria ?? []),
      'out-of-scope': fill('out-of-scope', spec.requirements?.out_of_scope ?? []),
      assumption: fill('assumption', spec.requirements?.assumptions ?? []),
      risk: fill('risk', spec.requirements?.risks ?? []),
    },
  };
}
