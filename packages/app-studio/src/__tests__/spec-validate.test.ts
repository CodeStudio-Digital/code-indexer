import { describe, expect, it } from 'vitest';
import { validateAppSpec } from '../spec/validate.js';
import { parseAppSpec, serializeAppSpec } from '../spec/types.js';
import { makeSpec } from './fixtures.js';

describe('validateAppSpec', () => {
  it('accepts a complete spec', () => {
    expect(validateAppSpec(makeSpec())).toEqual([]);
  });

  it('rejects non-objects and wrong version', () => {
    expect(validateAppSpec(null)).toEqual(['spec must be a JSON object']);
    expect(validateAppSpec({ ...makeSpec(), v: 2 }).join()).toContain('v must be 1');
  });

  it('requires at least one screen and exactly one primary', () => {
    expect(validateAppSpec(makeSpec({ screens: [] })).join()).toContain('at least 1 screen');
    const twoPrimary = makeSpec({
      screens: [
        { id: 'a', name: 'AScreen', label: 'A', purpose: 'x', primary: true },
        { id: 'b', name: 'BScreen', label: 'B', purpose: 'y', primary: true },
      ],
    });
    expect(validateAppSpec(twoPrimary).join()).toContain('exactly 1 screen');
  });

  it('flags feature references to unknown screens', () => {
    const spec = makeSpec({
      features: [{ id: 'f', name: 'F', description: 'd', screen_ids: ['nope'] }],
    });
    expect(validateAppSpec(spec).join()).toContain("unknown screen 'nope'");
  });

  it('rejects duplicate screen component names (collapses roadmap coverage + file collision)', () => {
    const spec = makeSpec({
      features: [{ id: 'f', name: 'F', description: 'd', screen_ids: ['a', 'b'] }],
      screens: [
        { id: 'a', name: 'DupScreen', label: 'A', purpose: 'x', primary: true },
        { id: 'b', name: 'DupScreen', label: 'B', purpose: 'y' },
      ],
    });
    expect(validateAppSpec(spec).join('\n')).toContain("name 'DupScreen' is duplicated");
  });

  it('enforces naming conventions (snake entities, kebab ids, Pascal screens)', () => {
    const spec = makeSpec();
    spec.database.entities[0].name = 'Pedidos!';
    spec.screens[0].name = 'painel_screen';
    const issues = validateAppSpec(spec).join('\n');
    expect(issues).toContain('snake_case');
    expect(issues).toContain('PascalCase');
  });

  it('requires entities when database.required and valid field types + references', () => {
    expect(validateAppSpec(makeSpec({ database: { required: true, entities: [] } })).join()).toContain(
      'entities is empty',
    );
    const spec = makeSpec();
    spec.database.entities[0].fields[0].type = 'money' as never;
    spec.database.entities[0].fields[1].references = 'clientes';
    const issues = validateAppSpec(spec).join('\n');
    expect(issues).toContain('text|integer|real|timestamp');
    expect(issues).toContain("references 'clientes' is not a known entity");
  });

  it('auth: enabled needs methods; protected ids must exist', () => {
    const spec = makeSpec({ auth: { enabled: true, methods: [], protected_screen_ids: ['ghost'] } });
    const issues = validateAppSpec(spec).join('\n');
    expect(issues).toContain('methods is empty');
    expect(issues).toContain("unknown screen 'ghost'");
  });
});

describe('parse/serialize', () => {
  it('round-trips and rejects garbage', () => {
    const spec = makeSpec();
    expect(parseAppSpec(serializeAppSpec(spec))).toEqual(spec);
    expect(parseAppSpec('not json')).toBeNull();
    expect(parseAppSpec(JSON.stringify({ v: 9 }))).toBeNull();
    expect(parseAppSpec(null)).toBeNull();
  });
});
