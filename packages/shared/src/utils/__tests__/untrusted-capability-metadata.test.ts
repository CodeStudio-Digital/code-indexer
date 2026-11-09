import { describe, expect, it } from 'vitest';
import { sanitizeUntrustedCapabilityMetadata as sanitize } from '../untrusted-capability-metadata.js';
// Exported from rea-agents 6.5.0, browserScenarioInputSchema (Zod 4.4.3,
// input/draft-7). MIT copyright 2026 morluto; see fixtures/rea-LICENSE.txt.
import rea from './fixtures/rea-capture-browser-scenario.schema.json' with { type: 'json' };

describe('external tool schemas remain complete JSON contracts', () => {
  it('preserves the real 17-level REA capture_browser_scenario contract without introducing nulls', () => {
    const result = sanitize('Run a controlled browser scenario', rea);
    expect(result.schemaError).toBeUndefined();
    expect(result.truncated).toBe(false);
    expect(result.schema).toEqual(rea);
    expect(JSON.stringify(result.schema)).not.toContain(':null');
    expect(result.schema).not.toBe(rea);
  });

  it('does not shorten property names, enum values, required lists, refs, patterns or annotations', () => {
    const key = 'x'.repeat(300), value = 'v'.repeat(5000);
    const shared = { type: 'string' };
    const schema = { type: 'object', properties: {
      [key]: { enum: Array.from({ length: 150 }, (_, i) => `value-${i}`), const: value, pattern: '^x$', default: null },
      ...Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`p${i}`, shared])),
      optional: { anyOf: [{ $ref: '#/$defs/value' }, { type: 'null' }] },
    }, required: [key], $defs: { value: { type: 'string', description: value } } };
    const result = sanitize('d'.repeat(5000), schema);
    expect(result.schemaError).toBeUndefined();
    expect(result.schema).toEqual(schema);
    expect(result.description).toHaveLength(4096);
    expect(result.truncated).toBe(true); // only the separate tool description
  });

  it.each([
    ['non-object root', true],
    ['array root', []],
    ['non-JSON value', { value: undefined }],
    ['non-finite number', { value: NaN }],
    ['sparse array', { enum: new Array(3) }],
    ['byte budget', { description: 'ã'.repeat(33_000) }],
    ['node budget', { enum: Array.from({ length: 4100 }, () => 0) }],
    ['depth budget', Array.from({ length: 70 }).reduce<object>((items) => ({ items }), { type: 'string' })],
  ])('rejects %s atomically instead of publishing a partial contract', (_reason, schema) => {
    const result = sanitize('safe description', schema);
    expect(result.schemaError).toEqual(expect.any(String));
    expect(result.schema).toEqual({ type: 'object', properties: {}, not: {} });
    expect(result.truncated).toBe(true);
  });

  it('rejects a cycle but allows acyclic reused references without changing the input', () => {
    const schema: Record<string, unknown> = { type: 'object' };
    schema.properties = schema;
    expect(sanitize('', schema).schemaError).toContain('cycle');
    expect(schema.properties).toBe(schema);
    const child = { type: 'string' };
    expect(sanitize('', { properties: { a: child, b: child } }).schemaError).toBeUndefined();
  });
});
