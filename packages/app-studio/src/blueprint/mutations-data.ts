/**
 * Mutações de dados do Blueprint — entity/field/behavior (split de
 * mutations.ts pelo cap de LOC). Mesmo contrato: cirúrgico, cascades
 * reportados em `cascaded`.
 */
import type { AppBehaviorAction, AppBehaviorTrigger, AppFieldType, AppSpec } from '../spec/types.js';
import { kebab, snake, titleize } from '../spec/names.js';

export type BlueprintDataMutation =
  | { op: 'add-entity'; label: string }
  | { op: 'update-entity'; entity: string; patch: { label?: string } }
  | { op: 'remove-entity'; entity: string }
  | { op: 'add-field'; entity: string; label: string; type?: AppFieldType }
  | { op: 'update-field'; entity: string; field: string; patch: { label?: string; type?: AppFieldType; required?: boolean } }
  | { op: 'remove-field'; entity: string; field: string }
  | { op: 'set-field-reference'; entity: string; target: string }
  | { op: 'add-behavior'; screen_id: string; trigger: AppBehaviorTrigger; trigger_label: string; action: AppBehaviorAction }
  | { op: 'update-behavior'; behavior_id: string; patch: { trigger?: AppBehaviorTrigger; trigger_label?: string } }
  | { op: 'remove-behavior'; behavior_id: string }
  | { op: 'add-behavior-action'; behavior_id: string; action: AppBehaviorAction }
  | { op: 'remove-behavior-action'; behavior_id: string; index: number };

const DATA_OPS: ReadonlySet<string> = new Set([
  'add-entity', 'update-entity', 'remove-entity',
  'add-field', 'update-field', 'remove-field', 'set-field-reference',
  'add-behavior', 'update-behavior', 'remove-behavior',
  'add-behavior-action', 'remove-behavior-action',
]);

export function isDataMutation(m: { op: string }): m is BlueprintDataMutation {
  return DATA_OPS.has(m.op);
}

function uniqueName(base: string, taken: ReadonlySet<string>, sep: '-' | '_'): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}${sep}${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function entityOf(spec: AppSpec, name: string) {
  const entity = spec.database.entities.find((e) => e.name === name);
  if (!entity) throw new Error(`Unknown entity '${name}'.`);
  return entity;
}

function behaviorOf(spec: AppSpec, id: string) {
  const behavior = (spec.behaviors ?? []).find((b) => b.id === id);
  if (!behavior) throw new Error(`Unknown behavior '${id}'.`);
  return behavior;
}

/** Remove uma entity + referências (FKs de outras entities, actions save). */
export function removeEntityCascade(spec: AppSpec, name: string, cascaded: string[]): void {
  const entity = entityOf(spec, name);
  spec.database.entities = spec.database.entities.filter((e) => e.name !== name);
  for (const other of spec.database.entities) {
    for (const field of other.fields) {
      if (field.references === name) {
        delete field.references;
        cascaded.push(`ligação '${other.label}.${field.name}' → '${entity.label}' removida`);
      }
    }
  }
  const behaviors = spec.behaviors ?? [];
  spec.behaviors = behaviors.filter((b) => {
    const before = b.actions.length;
    b.actions = b.actions.filter((a) => !(a.kind === 'save' && a.entity === name));
    if (b.actions.length !== before) cascaded.push(`ação de salvar removida de '${b.trigger_label}'`);
    if (b.actions.length === 0) {
      cascaded.push(`comportamento '${b.trigger_label}' removido (ficou sem ações)`);
      return false;
    }
    return true;
  });
}

export function applyDataMutation(spec: AppSpec, m: BlueprintDataMutation, cascaded: string[]): void {
  switch (m.op) {
    case 'add-entity': {
      const taken = new Set(spec.database.entities.map((e) => e.name));
      const name = uniqueName(snake(m.label) || 'dados', taken, '_');
      spec.database.required = true;
      spec.database.entities.push({
        name,
        label: m.label,
        fields: [{ name: 'id', label: 'Id', type: 'integer' }],
      });
      break;
    }
    case 'update-entity': {
      const entity = entityOf(spec, m.entity);
      if (m.patch.label !== undefined) entity.label = m.patch.label;
      break;
    }
    case 'remove-entity':
      removeEntityCascade(spec, m.entity, cascaded);
      break;
    case 'add-field': {
      const entity = entityOf(spec, m.entity);
      const taken = new Set(entity.fields.map((f) => f.name));
      entity.fields.push({
        name: uniqueName(snake(m.label) || 'campo', taken, '_'),
        label: m.label,
        type: m.type ?? 'text',
      });
      break;
    }
    case 'update-field': {
      const entity = entityOf(spec, m.entity);
      const field = entity.fields.find((f) => f.name === m.field);
      if (!field) throw new Error(`Unknown field '${m.entity}.${m.field}'.`);
      if (m.patch.label !== undefined) field.label = m.patch.label;
      if (m.patch.type !== undefined) field.type = m.patch.type;
      if (m.patch.required !== undefined) {
        if (m.patch.required) field.required = true;
        else delete field.required;
      }
      break;
    }
    case 'remove-field': {
      const entity = entityOf(spec, m.entity);
      if (!entity.fields.some((f) => f.name === m.field)) throw new Error(`Unknown field '${m.entity}.${m.field}'.`);
      entity.fields = entity.fields.filter((f) => f.name !== m.field);
      if (entity.fields.length === 0) {
        entity.fields.push({ name: 'id', label: 'Id', type: 'integer' });
        cascaded.push(`'${entity.label}' ficou sem campos — campo 'id' recriado`);
      }
      break;
    }
    case 'set-field-reference': {
      const entity = entityOf(spec, m.entity);
      const target = entityOf(spec, m.target); // valida o alvo
      const fkName = `${m.target}_id`;
      const existing = entity.fields.find((f) => f.name === fkName);
      if (existing) {
        existing.references = m.target;
        existing.type = 'integer';
      } else {
        entity.fields.push({ name: fkName, label: titleize(fkName), type: 'integer', references: m.target });
        cascaded.push(`campo '${fkName}' criado em '${entity.label}' ligando a '${target.label}'`);
      }
      break;
    }
    case 'add-behavior': {
      if (!spec.screens.some((s) => s.id === m.screen_id)) throw new Error(`Unknown screen '${m.screen_id}'.`);
      const taken = new Set((spec.behaviors ?? []).map((b) => b.id));
      spec.behaviors = [
        ...(spec.behaviors ?? []),
        {
          id: uniqueName(kebab(m.trigger_label) || 'acao', taken, '-'),
          screen_id: m.screen_id,
          trigger: m.trigger,
          trigger_label: m.trigger_label,
          actions: [m.action],
        },
      ];
      break;
    }
    case 'update-behavior': {
      const behavior = behaviorOf(spec, m.behavior_id);
      if (m.patch.trigger !== undefined) behavior.trigger = m.patch.trigger;
      if (m.patch.trigger_label !== undefined) behavior.trigger_label = m.patch.trigger_label;
      break;
    }
    case 'remove-behavior':
      behaviorOf(spec, m.behavior_id); // valida
      spec.behaviors = (spec.behaviors ?? []).filter((b) => b.id !== m.behavior_id);
      break;
    case 'add-behavior-action': {
      const behavior = behaviorOf(spec, m.behavior_id);
      behavior.actions.push(m.action);
      break;
    }
    case 'remove-behavior-action': {
      const behavior = behaviorOf(spec, m.behavior_id);
      if (m.index < 0 || m.index >= behavior.actions.length) throw new Error(`Action index ${m.index} out of range.`);
      behavior.actions.splice(m.index, 1);
      if (behavior.actions.length === 0) {
        spec.behaviors = (spec.behaviors ?? []).filter((b) => b.id !== m.behavior_id);
        cascaded.push(`comportamento '${behavior.trigger_label}' removido (ficou sem ações)`);
      }
      break;
    }
    default: {
      const never: never = m;
      throw new Error(`Unknown data mutation ${JSON.stringify(never)}`);
    }
  }
}
