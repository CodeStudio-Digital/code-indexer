import { describe, expect, it } from 'vitest';
import { normalizeAppSpec } from '../spec/normalize.js';
import { validateAppSpec } from '../spec/validate.js';
import type { AppSpec } from '../spec/types.js';

/**
 * Reproduz o formato "natural" que os modelos (GLM/zai, gpt-5.5) mandaram e
 * que fazia o app_save_spec recusar 5x seguidas: features/fields como
 * strings, screens com `description` sem `id`, auth.methods com
 * email_password/google. A normalização + validação DEVE aceitar.
 */
const NATURAL_SPEC = {
  v: 1,
  summary: 'Jogo manager de futebol online',
  audience: 'Fãs de manager de futebol',
  locale: 'pt-BR',
  // features como STRINGS (o modelo mandou assim)
  features: ['Cadastro e login de usuário', 'Escolha de clube fictício', 'Simulação de partida'],
  // screens com `description` e SEM `id`, nenhum primary
  screens: [
    { name: 'LoginScreen', label: 'Login e cadastro', description: 'Entrar por email/senha ou Google' },
    { name: 'DashboardScreen', label: 'Painel inicial', description: 'Visão geral do clube' },
  ],
  database: {
    required: true,
    entities: [
      // entity sem `label`, fields como STRINGS
      { name: 'users', description: 'Usuários', fields: ['id', 'name', 'email', 'password_hash', 'created_at'] },
      { name: 'clubs', description: 'Clubes', fields: ['id', 'name', 'balance', 'transfer_budget', 'reputation'] },
    ],
  },
  // methods no formato errado + roles extra (ignorado)
  auth: { enabled: true, methods: ['email_password', 'google'], roles: ['user', 'admin'] },
  design: { tone: 'Esportivo e profissional' },
};

describe('normalizeAppSpec', () => {
  it('coerces the natural model output into a spec that validates clean', () => {
    const normalized = normalizeAppSpec(NATURAL_SPEC);
    expect(validateAppSpec(normalized)).toEqual([]);
  });

  it('wraps string features into objects with kebab ids', () => {
    const spec = normalizeAppSpec(NATURAL_SPEC) as AppSpec;
    expect(spec.features[0]).toMatchObject({ id: 'cadastro-e-login-de-usuario', name: 'Cadastro e login de usuário', screen_ids: [] });
  });

  it('derives screen ids, maps description→purpose, and sets one primary', () => {
    const spec = normalizeAppSpec(NATURAL_SPEC) as AppSpec;
    expect(spec.screens[0]).toMatchObject({ id: 'login-screen', purpose: 'Entrar por email/senha ou Google' });
    expect(spec.screens.filter((s) => s.primary)).toHaveLength(1);
    expect(spec.screens[0].primary).toBe(true);
  });

  it('wraps string fields into objects with inferred types + entity labels', () => {
    const spec = normalizeAppSpec(NATURAL_SPEC) as AppSpec;
    const users = spec.database.entities[0];
    expect(users.label).toBe('Users');
    const byName = Object.fromEntries(users.fields.map((f) => [f.name, f.type]));
    expect(byName).toMatchObject({ id: 'integer', name: 'text', email: 'text', created_at: 'timestamp' });
    const clubs = spec.database.entities[1];
    expect(Object.fromEntries(clubs.fields.map((f) => [f.name, f.type]))).toMatchObject({ balance: 'real', reputation: 'integer' });
  });

  it('aliases auth methods to the canonical enum', () => {
    const spec = normalizeAppSpec(NATURAL_SPEC) as AppSpec;
    expect(spec.auth.methods).toEqual(['password', 'oauth-google']);
  });

  it('also accepts the earlier variants emailPassword / oauth', () => {
    const spec = normalizeAppSpec({ ...NATURAL_SPEC, auth: { enabled: true, methods: ['emailPassword', 'google', 'oauth'] } }) as AppSpec;
    // 'oauth' alone is ambiguous → dropped; the rest map.
    expect(spec.auth.methods).toEqual(['password', 'oauth-google']);
  });

  it('is a no-op passthrough for non-objects (validator rejects them)', () => {
    expect(normalizeAppSpec(null)).toBeNull();
    expect(validateAppSpec(normalizeAppSpec('nope')).length).toBeGreaterThan(0);
  });
});
