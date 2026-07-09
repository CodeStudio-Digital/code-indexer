/**
 * Validação dos `behaviors` da AppSpec (nós de fluxo do Blueprint) —
 * módulo próprio chamado no fim de `validateAppSpec` (inline estouraria o
 * cap de 200 LOC do validate.ts). Mesmo contrato: issues acionáveis, o
 * consumidor é o agente/canvas.
 */

const KEBAB_RE = /^[a-z][a-z0-9-]*$/;
const TRIGGERS = new Set(['click', 'submit', 'open']);
const ACTION_KINDS = new Set(['save', 'navigate', 'notify']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function str(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * `behaviors` é opcional: ausente/array vazio = ok. `screenIds`/`entityNames`
 * vêm do validador principal (já coletados lá).
 */
export function validateBehaviors(
  behaviors: unknown,
  screenIds: ReadonlySet<string>,
  entityNames: ReadonlySet<string>,
): string[] {
  if (behaviors === undefined || behaviors === null) return [];
  if (!Array.isArray(behaviors)) return ['behaviors must be an array (or omitted)'];

  const issues: string[] = [];
  const seen = new Set<string>();
  behaviors.forEach((b, i) => {
    if (!isRecord(b)) return issues.push(`behaviors[${i}] must be an object`);
    if (!str(b.id) || !KEBAB_RE.test(b.id as string)) {
      issues.push(`behaviors[${i}].id must be kebab-case (e.g. 'salvar-pedido')`);
    } else if (seen.has(b.id as string)) {
      issues.push(`behaviors[${i}].id '${String(b.id)}' is duplicated`);
    } else {
      seen.add(b.id as string);
    }
    if (typeof b.screen_id !== 'string' || !screenIds.has(b.screen_id)) {
      issues.push(`behaviors[${i}].screen_id references unknown screen '${String(b.screen_id)}'`);
    }
    if (!TRIGGERS.has(b.trigger as string)) {
      issues.push(`behaviors[${i}].trigger must be click|submit|open`);
    }
    if (!str(b.trigger_label)) {
      issues.push(`behaviors[${i}].trigger_label: human description of the trigger (user's language)`);
    }
    if (!Array.isArray(b.actions) || b.actions.length === 0) {
      issues.push(`behaviors[${i}].actions: at least 1 action is required`);
      return;
    }
    (b.actions as unknown[]).forEach((a, j) => {
      if (!isRecord(a) || !ACTION_KINDS.has(a.kind as string)) {
        issues.push(`behaviors[${i}].actions[${j}].kind must be save|navigate|notify`);
        return;
      }
      if (a.kind === 'save' && (typeof a.entity !== 'string' || !entityNames.has(a.entity))) {
        issues.push(`behaviors[${i}].actions[${j}] (save) references unknown entity '${String(a.entity)}'`);
      }
      if (a.kind === 'navigate' && (typeof a.screen_id !== 'string' || !screenIds.has(a.screen_id))) {
        issues.push(`behaviors[${i}].actions[${j}] (navigate) references unknown screen '${String(a.screen_id)}'`);
      }
      if (a.kind === 'notify' && !str(a.message)) {
        issues.push(`behaviors[${i}].actions[${j}] (notify) needs a non-empty message`);
      }
    });
  });
  return issues;
}
