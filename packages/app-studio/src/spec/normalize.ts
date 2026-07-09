/**
 * Normalização tolerante da AppSpec antes de validar. O modelo (qualquer
 * provedor) produz variações NATURAIS que não batem 1:1 com o schema
 * canônico: features como strings, screens com `description` em vez de
 * `purpose` e sem `id`, fields como strings, `auth.methods` com
 * `email_password`/`google`. Em vez de recusar (o fluxo do leigo NÃO pode
 * travar), coagimos essas variações para a forma canônica de forma
 * determinística; o que sobra de genuinamente inválido o `validateAppSpec`
 * pega depois.
 */
import type {
  AppBehavior,
  AppBehaviorAction,
  AppFieldType,
  AppSpecEntity,
  AppSpecField,
  AppSpecFeature,
  AppSpecScreen,
} from './types.js';
import { kebab, snake, titleize } from './names.js';

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

// Métodos de auth: o enum canônico é password | oauth-google | oauth-github,
// mas o modelo escreve naturalmente email/email_password/google/github.
const AUTH_ALIAS: Record<string, string> = {
  password: 'password',
  email: 'password',
  email_password: 'password',
  emailpassword: 'password',
  emailandpassword: 'password',
  'email/senha': 'password',
  senha: 'password',
  credentials: 'password',
  magiclink: 'password',
  google: 'oauth-google',
  googleoauth: 'oauth-google',
  oauth_google: 'oauth-google',
  'oauth-google': 'oauth-google',
  github: 'oauth-github',
  githuboauth: 'oauth-github',
  oauth_github: 'oauth-github',
  'oauth-github': 'oauth-github',
};

const FIELD_TYPES = new Set<AppFieldType>(['text', 'integer', 'real', 'timestamp']);

/** Heurística de tipo pelo nome (só quando o modelo manda field como string). */
function inferType(name: string): AppFieldType {
  const n = name.toLowerCase();
  if (n === 'id' || n.endsWith('_id')) return 'integer';
  if (n.endsWith('_at') || n.includes('date') || n === 'created' || n === 'updated') return 'timestamp';
  if (/(price|amount|value|balance|salary|budget|fee|rating|xg|percent|possession|weight|height|difference)/.test(n)) {
    return 'real';
  }
  if (/(age|year|count|qty|quantity|number|total|goals|assists|points|played|won|lost|drawn|capacity|minute|matchday|appearances|reputation|ability|morale|fitness|level|confidence|score|cards|shots|corners|fouls)/.test(n)) {
    return 'integer';
  }
  return 'text';
}

function coerceField(f: unknown): AppSpecField {
  if (typeof f === 'string') {
    return { name: snake(f), label: titleize(f), type: inferType(f) };
  }
  const o = rec(f);
  const name = str(o.name) || str(o.field) || str(o.column);
  const type = FIELD_TYPES.has(o.type as AppFieldType) ? (o.type as AppFieldType) : inferType(name);
  return {
    name: snake(name),
    label: str(o.label) || titleize(name),
    type,
    ...(o.required === true ? { required: true } : {}),
    ...(str(o.references) ? { references: snake(str(o.references)) } : {}),
  };
}

function coerceEntity(e: unknown, i: number): AppSpecEntity {
  const o = rec(e);
  const name = str(o.name) || str(o.table) || `entity_${i + 1}`;
  return {
    name: snake(name),
    label: str(o.label) || titleize(name),
    fields: Array.isArray(o.fields) ? o.fields.map(coerceField) : [],
  };
}

function coerceFeature(f: unknown, i: number): AppSpecFeature {
  if (typeof f === 'string') {
    return { id: kebab(f) || `feature-${i + 1}`, name: f, description: f, screen_ids: [] };
  }
  const o = rec(f);
  const name = str(o.name) || str(o.title) || `Feature ${i + 1}`;
  return {
    id: kebab(str(o.id) || name) || `feature-${i + 1}`,
    name,
    description: str(o.description) || str(o.desc) || name,
    screen_ids: Array.isArray(o.screen_ids)
      ? o.screen_ids.filter((s): s is string => typeof s === 'string').map(kebab)
      : [],
  };
}

function coerceScreen(s: unknown, i: number): AppSpecScreen {
  const o = rec(s);
  const name = str(o.name) || `Screen${i + 1}`;
  return {
    id: kebab(str(o.id) || name) || `screen-${i + 1}`,
    name,
    label: str(o.label) || str(o.title) || name,
    // `purpose` é o campo canônico; o modelo costuma mandar `description`.
    purpose: str(o.purpose) || str(o.description) || str(o.label) || name,
    ...(o.primary === true ? { primary: true } : {}),
  };
}

// Aliases naturais dos triggers/ações de behavior (o modelo escreve
// on_click/onSubmit/save_to/toast…; o canônico é click|submit|open e
// save|navigate|notify).
const TRIGGER_ALIAS: Record<string, AppBehavior['trigger']> = {
  click: 'click', on_click: 'click', onclick: 'click', press: 'click', tap: 'click',
  submit: 'submit', on_submit: 'submit', onsubmit: 'submit', form_submit: 'submit', enviar: 'submit',
  open: 'open', on_open: 'open', onopen: 'open', load: 'open', on_load: 'open', mount: 'open', abrir: 'open',
};
const ACTION_KIND_ALIAS: Record<string, AppBehaviorAction['kind']> = {
  save: 'save', save_to: 'save', insert: 'save', create: 'save', store: 'save', salvar: 'save',
  navigate: 'navigate', goto: 'navigate', go_to: 'navigate', redirect: 'navigate', navegar: 'navigate',
  notify: 'notify', toast: 'notify', alert: 'notify', message: 'notify', aviso: 'notify',
};

function coerceBehaviorAction(a: unknown): AppBehaviorAction | null {
  const o = rec(a);
  const kind = ACTION_KIND_ALIAS[snake(str(o.kind) || str(o.type) || str(o.action))];
  if (kind === 'save') {
    const entity = snake(str(o.entity) || str(o.table) || str(o.target));
    return entity ? { kind: 'save', entity } : null;
  }
  if (kind === 'navigate') {
    const screenId = kebab(str(o.screen_id) || str(o.screen) || str(o.target) || str(o.to));
    return screenId ? { kind: 'navigate', screen_id: screenId } : null;
  }
  if (kind === 'notify') {
    const message = str(o.message) || str(o.text) || str(o.target);
    return message ? { kind: 'notify', message } : null;
  }
  return null;
}

function coerceBehavior(b: unknown, i: number): AppBehavior {
  const o = rec(b);
  const label = str(o.trigger_label) || str(o.label) || str(o.description) || str(o.name);
  const trigger = TRIGGER_ALIAS[snake(str(o.trigger) || str(o.event) || str(o.on))] ?? 'click';
  return {
    id: kebab(str(o.id) || label) || `behavior-${i + 1}`,
    screen_id: kebab(str(o.screen_id) || str(o.screen)),
    trigger,
    trigger_label: label || `behavior-${i + 1}`,
    actions: Array.isArray(o.actions)
      ? o.actions.map(coerceBehaviorAction).filter((a): a is AppBehaviorAction => a !== null)
      : [],
  };
}

/** Garante exatamente uma tela primary (a home). */
function ensureSinglePrimary(screens: AppSpecScreen[]): void {
  const primaries = screens.filter((s) => s.primary);
  if (primaries.length === 0 && screens.length > 0) {
    screens[0].primary = true;
  } else if (primaries.length > 1) {
    let kept = false;
    for (const s of screens) {
      if (!s.primary) continue;
      if (kept) delete s.primary;
      else kept = true;
    }
  }
}

/**
 * Coage a spec crua para a forma canônica. Retorna `unknown` (ainda passa
 * pelo `validateAppSpec`); não-objeto volta como veio para o validador
 * rejeitar com mensagem clara.
 */
export function normalizeAppSpec(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const r = raw as Record<string, unknown>;

  const screens = Array.isArray(r.screens) ? r.screens.map(coerceScreen) : undefined;
  if (screens) ensureSinglePrimary(screens);

  const db = rec(r.database);
  const database = Array.isArray(db.entities)
    ? { ...db, required: db.required !== false, entities: db.entities.map(coerceEntity) }
    : r.database;

  const auth = rec(r.auth);
  const methods = Array.isArray(auth.methods)
    ? Array.from(
        new Set(
          auth.methods
            .map((m) => AUTH_ALIAS[str(m).toLowerCase().trim().replace(/\s+/g, '')])
            .filter((m): m is string => !!m),
        ),
      )
    : undefined;

  const out: Record<string, unknown> = {
    ...r,
    v: 1,
    features: Array.isArray(r.features) ? r.features.map(coerceFeature) : r.features,
  };
  if (screens) out.screens = screens;
  if (database) out.database = database;
  if (Array.isArray(auth.methods)) out.auth = { ...auth, methods };
  if (Array.isArray(r.behaviors)) out.behaviors = r.behaviors.map(coerceBehavior);
  return out;
}
