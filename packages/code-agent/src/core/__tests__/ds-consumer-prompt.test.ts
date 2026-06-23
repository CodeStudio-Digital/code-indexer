import { describe, expect, it } from 'vitest';
import type { DesignSystemStore } from '@mcp/store/design-system-store.js';
import { buildDsConsumerBlock } from '../ds-consumer-prompt.js';
import type { DsConsumerConfig } from '../builder-config.js';

const CONSUMER: DsConsumerConfig = { sessionId: 3, packageName: '@acme/ui', semver: '1.2.0' };

function component(name: string, props: string | null = null) {
  return {
    id: 1,
    version_id: 7,
    name,
    kind: 'atom' as const,
    props_schema_json: props,
    example_code: null,
    created_at: 'x',
  };
}

function fakeStore(components = [component('Card'), component('Button', JSON.stringify({ properties: { variant: { enum: ['a', 'b'] } } }))]): DesignSystemStore {
  return {
    getSession: () => ({ id: 3, package_name: '@acme/ui', stack: 'react-ts' }),
    getVersionBySemver: () => ({
      id: 7,
      semver: '1.2.0',
      status: 'published',
      manifest_json: JSON.stringify({ tokens: { color: { primary: '#111' }, radius: '4px' } }),
    }),
    listComponents: () => components,
  } as unknown as DesignSystemStore;
}

describe('buildDsConsumerBlock', () => {
  it('pins the package, states the override policy and lists inventory + tokens', () => {
    const block = buildDsConsumerBlock(CONSUMER, fakeStore());
    expect(block).toContain('`@acme/ui@1.2.0`');
    expect(block).toContain("import { Button } from '@acme/ui'");
    expect(block).toContain('does NOT apply'); // shadcn-always supersession
    expect(block).toContain('- Button (atom) — variant: a|b');
    expect(block).toContain('- Card (atom)');
    expect(block).toContain('color.primary');
    expect(block).toContain('radius');
    expect(block).toContain('ds_component');
  });

  it('is deterministic and sorted regardless of store order', () => {
    const a = buildDsConsumerBlock(CONSUMER, fakeStore([component('Zeta'), component('Alpha')]));
    const b = buildDsConsumerBlock(CONSUMER, fakeStore([component('Alpha'), component('Zeta')]));
    expect(a).toBe(b);
    expect(a.indexOf('Alpha')).toBeLessThan(a.indexOf('Zeta'));
  });

  it('caps the inventory at 60 and summarizes the rest', () => {
    const many = Array.from({ length: 75 }, (_, i) => component(`C${String(i).padStart(3, '0')}`));
    const block = buildDsConsumerBlock(CONSUMER, fakeStore(many));
    expect(block).toContain('… and 15 more');
    expect(block).toContain('C059');
    expect(block).not.toContain('C060');
  });

  it('degrades to a minimal block when the store is missing', () => {
    const block = buildDsConsumerBlock(CONSUMER, null);
    expect(block).toContain('`@acme/ui@1.2.0`');
    expect(block).toContain('inventory unavailable');
    expect(block).toContain('re-link');
  });

  it('degrades when the pinned version is gone or unpublished', () => {
    const store = {
      getSession: () => ({ id: 3 }),
      getVersionBySemver: () => null,
      listComponents: () => [],
    } as unknown as DesignSystemStore;
    const block = buildDsConsumerBlock(CONSUMER, store);
    expect(block).toContain('inventory unavailable');
  });
});
