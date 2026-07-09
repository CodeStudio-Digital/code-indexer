/**
 * Mutações nomeadas do Blueprint — edições CIRÚRGICAS e imutáveis na
 * AppSpec (o grafo é só view). Cascades são explícitos e REPORTADOS em
 * `cascaded` (alimenta o confirm de remoção da UI). Invariante garantida
 * por teste: mutação válida sobre spec válida ⇒ `validateAppSpec` limpo.
 *
 * Ops de screen/feature/auth aqui; entity/field/behavior em
 * `mutations-data.ts` (split pelo cap de LOC).
 */
import type { AppSpec } from '../spec/types.js';
import { kebab, pascalScreenName } from '../spec/names.js';
import {
  applyDataMutation,
  isDataMutation,
  removeEntityCascade,
  type BlueprintDataMutation,
} from './mutations-data.js';

export type BlueprintMutation =
  | { op: 'add-screen'; label: string }
  | { op: 'update-screen'; screen_id: string; patch: { label?: string; purpose?: string; primary?: true } }
  | { op: 'remove-screen'; screen_id: string }
  | { op: 'add-feature'; name: string; description?: string }
  | { op: 'update-feature'; feature_id: string; patch: { name?: string; description?: string } }
  | { op: 'remove-feature'; feature_id: string }
  | { op: 'connect-feature-screen'; feature_id: string; screen_id: string }
  | { op: 'disconnect-feature-screen'; feature_id: string; screen_id: string }
  | { op: 'set-auth-enabled'; enabled: boolean }
  | { op: 'protect-screen'; screen_id: string }
  | { op: 'unprotect-screen'; screen_id: string }
  | BlueprintDataMutation;

export interface MutationResult {
  spec: AppSpec;
  /** Descrições curtas do que foi removido/alterado em cascata. */
  cascaded: string[];
}

export function uniqueId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function clone(spec: AppSpec): AppSpec {
  return JSON.parse(JSON.stringify(spec)) as AppSpec;
}

/** Remove uma tela + todas as referências a ela (cascade reportado). */
export function removeScreenCascade(spec: AppSpec, screenId: string, cascaded: string[]): void {
  const screen = spec.screens.find((s) => s.id === screenId);
  if (!screen) throw new Error(`Unknown screen '${screenId}'.`);
  spec.screens = spec.screens.filter((s) => s.id !== screenId);
  for (const f of spec.features) {
    if (f.screen_ids.includes(screenId)) {
      f.screen_ids = f.screen_ids.filter((id) => id !== screenId);
      cascaded.push(`feature '${f.name}' → tela desconectada`);
    }
  }
  if (spec.auth.protected_screen_ids?.includes(screenId)) {
    spec.auth.protected_screen_ids = spec.auth.protected_screen_ids.filter((id) => id !== screenId);
    cascaded.push(`proteção de login removida`);
  }
  const behaviors = spec.behaviors ?? [];
  spec.behaviors = behaviors.filter((b) => {
    if (b.screen_id === screenId) {
      cascaded.push(`comportamento '${b.trigger_label}' removido`);
      return false;
    }
    const before = b.actions.length;
    b.actions = b.actions.filter((a) => !(a.kind === 'navigate' && a.screen_id === screenId));
    if (b.actions.length !== before) cascaded.push(`ação de navegação removida de '${b.trigger_label}'`);
    if (b.actions.length === 0) {
      cascaded.push(`comportamento '${b.trigger_label}' removido (ficou sem ações)`);
      return false;
    }
    return true;
  });
  // Primary removida → promove a primeira restante (espírito do ensureSinglePrimary).
  if (screen.primary && spec.screens.length > 0 && !spec.screens.some((s) => s.primary)) {
    spec.screens[0].primary = true;
    cascaded.push(`'${spec.screens[0].label}' virou a tela inicial`);
  }
}

export function applySpecMutation(input: AppSpec, m: BlueprintMutation): MutationResult {
  const spec = clone(input);
  const cascaded: string[] = [];

  if (isDataMutation(m)) {
    applyDataMutation(spec, m, cascaded);
    return { spec, cascaded };
  }

  switch (m.op) {
    case 'add-screen': {
      const taken = new Set(spec.screens.map((s) => s.id));
      const id = uniqueId(kebab(m.label) || 'tela', taken);
      spec.screens.push({
        id,
        name: pascalScreenName(m.label),
        label: m.label,
        purpose: m.label,
        ...(spec.screens.length === 0 ? { primary: true } : {}),
      });
      break;
    }
    case 'update-screen': {
      const screen = spec.screens.find((s) => s.id === m.screen_id);
      if (!screen) throw new Error(`Unknown screen '${m.screen_id}'.`);
      if (m.patch.label !== undefined) screen.label = m.patch.label;
      if (m.patch.purpose !== undefined) screen.purpose = m.patch.purpose;
      if (m.patch.primary === true) {
        for (const s of spec.screens) delete s.primary;
        screen.primary = true;
      }
      break;
    }
    case 'remove-screen':
      removeScreenCascade(spec, m.screen_id, cascaded);
      break;
    case 'add-feature': {
      const taken = new Set(spec.features.map((f) => f.id));
      spec.features.push({
        id: uniqueId(kebab(m.name) || 'recurso', taken),
        name: m.name,
        description: m.description ?? m.name,
        screen_ids: [],
      });
      break;
    }
    case 'update-feature': {
      const feature = spec.features.find((f) => f.id === m.feature_id);
      if (!feature) throw new Error(`Unknown feature '${m.feature_id}'.`);
      if (m.patch.name !== undefined) feature.name = m.patch.name;
      if (m.patch.description !== undefined) feature.description = m.patch.description;
      break;
    }
    case 'remove-feature':
      if (!spec.features.some((f) => f.id === m.feature_id)) throw new Error(`Unknown feature '${m.feature_id}'.`);
      spec.features = spec.features.filter((f) => f.id !== m.feature_id);
      break;
    case 'connect-feature-screen': {
      const feature = spec.features.find((f) => f.id === m.feature_id);
      if (!feature) throw new Error(`Unknown feature '${m.feature_id}'.`);
      if (!spec.screens.some((s) => s.id === m.screen_id)) throw new Error(`Unknown screen '${m.screen_id}'.`);
      if (!feature.screen_ids.includes(m.screen_id)) feature.screen_ids.push(m.screen_id);
      break;
    }
    case 'disconnect-feature-screen': {
      const feature = spec.features.find((f) => f.id === m.feature_id);
      if (!feature) throw new Error(`Unknown feature '${m.feature_id}'.`);
      feature.screen_ids = feature.screen_ids.filter((id) => id !== m.screen_id);
      break;
    }
    case 'set-auth-enabled':
      spec.auth.enabled = m.enabled;
      if (m.enabled && (spec.auth.methods?.length ?? 0) === 0) spec.auth.methods = ['password'];
      if (!m.enabled) cascaded.push('telas protegidas continuam listadas, mas o login está desligado');
      break;
    case 'protect-screen': {
      if (!spec.screens.some((s) => s.id === m.screen_id)) throw new Error(`Unknown screen '${m.screen_id}'.`);
      const list = spec.auth.protected_screen_ids ?? [];
      if (!list.includes(m.screen_id)) spec.auth.protected_screen_ids = [...list, m.screen_id];
      break;
    }
    case 'unprotect-screen':
      spec.auth.protected_screen_ids = (spec.auth.protected_screen_ids ?? []).filter((id) => id !== m.screen_id);
      break;
    default: {
      const never: never = m;
      throw new Error(`Unknown mutation ${JSON.stringify(never)}`);
    }
  }
  return { spec, cascaded };
}

export { removeEntityCascade };
export type { BlueprintDataMutation };
