/**
 * Validador hand-rolled da AppSpec (padrão do repo: sem zod). Cada issue
 * nomeia o caminho do campo e o conserto — o consumidor é o AGENTE, que
 * corrige e re-chama `app_save_spec`; o leigo nunca vê JSON.
 */
import type { AppSpec } from './types.js';
import { validateBehaviors } from './validate-behaviors.js';

const SCREEN_ID_RE = /^[a-z][a-z0-9-]*$/;
const CODE_NAME_RE = /^[a-z][a-z0-9_]*$/;
const PASCAL_RE = /^[A-Z][A-Za-z0-9]*$/;
const FIELD_TYPES = new Set(['text', 'integer', 'real', 'timestamp']);
const AUTH_METHODS = new Set(['password', 'oauth-google', 'oauth-github']);
const REQUIREMENT_KEYS = new Set([
  'goals',
  'business_rules',
  'acceptance_criteria',
  'out_of_scope',
  'assumptions',
  'risks',
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

export function validateAppSpec(value: unknown): string[] {
  const issues: string[] = [];
  if (!isRecord(value)) return ['spec must be a JSON object'];
  const spec = value as Partial<AppSpec> & Record<string, unknown>;

  if (spec.v !== 1) issues.push("v must be 1 (spec schema version)");
  if (!str(spec.summary)) issues.push('summary: one plain sentence describing what the app does');
  if (!str(spec.audience)) issues.push('audience: who uses the app (e.g. "donos de lanchonete")');
  if (!str(spec.locale)) issues.push("locale: the user's language tag (e.g. 'pt-BR')");

  // ── screens ──
  const screenIds = new Set<string>();
  const screenNames = new Set<string>();
  if (!Array.isArray(spec.screens) || spec.screens.length === 0) {
    issues.push('screens: at least 1 screen is required');
  } else {
    spec.screens.forEach((s, i) => {
      if (!isRecord(s)) return issues.push(`screens[${i}] must be an object`);
      if (!str(s.id) || !SCREEN_ID_RE.test(s.id as string)) {
        issues.push(`screens[${i}].id must be kebab-case (e.g. 'lista-pedidos')`);
      } else if (screenIds.has(s.id as string)) {
        issues.push(`screens[${i}].id '${String(s.id)}' is duplicated`);
      } else {
        screenIds.add(s.id as string);
      }
      if (!str(s.name) || !PASCAL_RE.test(s.name as string)) {
        issues.push(`screens[${i}].name must be PascalCase (component name, e.g. 'OrdersScreen')`);
      } else if (screenNames.has((s.name as string).toLowerCase())) {
        // Duplicate names collapse roadmap coverage (one recorded feature
        // would satisfy two screens) AND collide as files in src/screens/.
        issues.push(`screens[${i}].name '${String(s.name)}' is duplicated — each screen needs a distinct component name`);
      } else {
        screenNames.add((s.name as string).toLowerCase());
      }
      if (!str(s.label)) issues.push(`screens[${i}].label: human name in the user's language`);
      if (!str(s.purpose)) issues.push(`screens[${i}].purpose: what the user does on this screen`);
    });
    const primaries = (spec.screens as unknown[]).filter((s) => isRecord(s) && s.primary === true);
    if (spec.screens.length > 0 && primaries.length !== 1) {
      issues.push(`exactly 1 screen must have primary:true (found ${primaries.length}) — the app's home route`);
    }
  }

  // ── features ──
  if (!Array.isArray(spec.features) || spec.features.length === 0) {
    issues.push('features: at least 1 feature is required');
  } else {
    const featureIds = new Set<string>();
    spec.features.forEach((f, i) => {
      if (!isRecord(f)) return issues.push(`features[${i}] must be an object`);
      if (!str(f.id) || !SCREEN_ID_RE.test(f.id as string)) {
        issues.push(`features[${i}].id must be kebab-case`);
      } else if (featureIds.has(f.id as string)) {
        issues.push(`features[${i}].id '${String(f.id)}' is duplicated`);
      } else {
        featureIds.add(f.id as string);
      }
      if (!str(f.name)) issues.push(`features[${i}].name is required`);
      if (!str(f.description)) issues.push(`features[${i}].description is required`);
      if (!Array.isArray(f.screen_ids)) {
        issues.push(`features[${i}].screen_ids must be an array (may be empty for API-only features)`);
      } else {
        for (const id of f.screen_ids as unknown[]) {
          if (typeof id !== 'string' || !screenIds.has(id)) {
            issues.push(`features[${i}].screen_ids references unknown screen '${String(id)}'`);
          }
        }
      }
    });
  }

  // ── database ──
  const entityNames = new Set<string>();
  if (!isRecord(spec.database) || typeof spec.database.required !== 'boolean') {
    issues.push('database.required must be true or false');
  } else {
    const entities = spec.database.entities;
    if (!Array.isArray(entities)) {
      issues.push('database.entities must be an array (empty when required:false)');
    } else {
      if (spec.database.required && entities.length === 0) {
        issues.push('database.required is true but entities is empty — model the data or set required:false');
      }
      entities.forEach((e, i) => {
        if (!isRecord(e)) return issues.push(`database.entities[${i}] must be an object`);
        if (!str(e.name) || !CODE_NAME_RE.test(e.name as string)) {
          issues.push(`database.entities[${i}].name must be snake_case (table name, e.g. 'pedidos')`);
        } else if (entityNames.has(e.name as string)) {
          issues.push(`database.entities[${i}].name '${String(e.name)}' is duplicated`);
        } else {
          entityNames.add(e.name as string);
        }
        if (!str(e.label)) issues.push(`database.entities[${i}].label: human name in the user's language`);
        if (!Array.isArray(e.fields) || e.fields.length === 0) {
          issues.push(`database.entities[${i}].fields: at least 1 field is required`);
          return;
        }
        (e.fields as unknown[]).forEach((f, j) => {
          if (!isRecord(f)) return issues.push(`database.entities[${i}].fields[${j}] must be an object`);
          if (!str(f.name) || !CODE_NAME_RE.test(f.name as string)) {
            issues.push(`database.entities[${i}].fields[${j}].name must be snake_case`);
          }
          if (!str(f.label)) issues.push(`database.entities[${i}].fields[${j}].label is required`);
          if (!FIELD_TYPES.has(f.type as string)) {
            issues.push(`database.entities[${i}].fields[${j}].type must be text|integer|real|timestamp`);
          }
        });
      });
      // FK references só depois de conhecer todos os nomes.
      entities.forEach((e, i) => {
        if (!isRecord(e) || !Array.isArray(e.fields)) return;
        (e.fields as unknown[]).forEach((f, j) => {
          if (isRecord(f) && f.references !== undefined) {
            if (typeof f.references !== 'string' || !entityNames.has(f.references)) {
              issues.push(
                `database.entities[${i}].fields[${j}].references '${String(f.references)}' is not a known entity`,
              );
            }
          }
        });
      });
    }
  }

  // ── auth ──
  if (!isRecord(spec.auth) || typeof spec.auth.enabled !== 'boolean') {
    issues.push('auth.enabled must be true or false (ask the user if the app needs login)');
  } else {
    for (const m of (spec.auth.methods ?? []) as unknown[]) {
      if (!AUTH_METHODS.has(m as string)) issues.push(`auth.methods contains unknown method '${String(m)}'`);
    }
    for (const id of (spec.auth.protected_screen_ids ?? []) as unknown[]) {
      if (typeof id !== 'string' || !screenIds.has(id)) {
        issues.push(`auth.protected_screen_ids references unknown screen '${String(id)}'`);
      }
    }
    if (spec.auth.enabled && (!Array.isArray(spec.auth.methods) || spec.auth.methods.length === 0)) {
      issues.push("auth.enabled is true but methods is empty — 'password' is the default choice");
    }
  }

  // ── design ──
  if (!isRecord(spec.design) || !str(spec.design.tone)) {
    issues.push("design.tone: a short style direction (e.g. 'clean e amigável, tons de verde')");
  }

  // ── requirements (opcional — refinamento de produto) ──
  if (spec.requirements !== undefined) {
    if (!isRecord(spec.requirements)) {
      issues.push('requirements must be an object when present');
    } else {
      for (const [key, value] of Object.entries(spec.requirements)) {
        if (!REQUIREMENT_KEYS.has(key)) {
          issues.push(`requirements.${key} is not supported`);
          continue;
        }
        if (!Array.isArray(value)) {
          issues.push(`requirements.${key} must be an array of text items`);
          continue;
        }
        value.forEach((item, i) => {
          if (!str(item)) issues.push(`requirements.${key}[${i}] must be non-empty text`);
        });
      }
    }
  }

  // ── behaviors (opcional — nós de fluxo do Blueprint) ──
  issues.push(...validateBehaviors(spec.behaviors, screenIds, entityNames));

  return issues;
}
