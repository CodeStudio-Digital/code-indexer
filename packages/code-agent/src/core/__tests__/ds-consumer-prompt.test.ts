import { describe, expect, it } from 'vitest';
import type { DesignSystemStore } from '@mcp/store/design-system-store.js';
import { buildDsConsumerBlock } from '../ds-consumer-prompt.js';
import type { DsConsumerConfig } from '../builder-config.js';
import { asSessionId } from '@mcp/session-storage';

const SESSION_ID = asSessionId('11111111-1111-4111-8111-111111111111');
const VERSION_ID = '22222222-2222-4222-8222-222222222222';
const CONSUMER: DsConsumerConfig = { sessionId: SESSION_ID, packageName: '@acme/ui', semver: '1.2.0' };

function component(name: string, props: string | null = null) {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    version_id: VERSION_ID,
    name,
    kind: 'atom' as const,
    props_schema_json: props,
    example_code: null,
    created_at: 'x',
  };
}

function fakeStore(components = [component('Card'), component('Button', JSON.stringify({ properties: { variant: { enum: ['a', 'b'] } } }))]): DesignSystemStore {
  return {
    getSession: async () => ({ id: SESSION_ID, package_name: '@acme/ui', stack: 'react-ts' }),
    getVersionBySemver: async () => ({
      id: VERSION_ID,
      semver: '1.2.0',
      status: 'published',
      manifest_json: JSON.stringify({ tokens: { color: { primary: '#111' }, radius: '4px' } }),
    }),
    listComponents: async () => components,
  } as unknown as DesignSystemStore;
}

describe('buildDsConsumerBlock', () => {
  it('pins the package, states the override policy and lists inventory + tokens', async () => {
    const block = await buildDsConsumerBlock(CONSUMER, fakeStore());
    expect(block).toContain('`@acme/ui@1.2.0`');
    expect(block).toContain("import { Button } from '@acme/ui'");
    expect(block).toContain('does NOT apply'); // shadcn-always supersession
    expect(block).toContain('- Button (atom) — variant: a|b');
    expect(block).toContain('- Card (atom)');
    expect(block).toContain('color.primary');
    expect(block).toContain('radius');
    expect(block).toContain('ds_component');
  });

  it('is deterministic and sorted regardless of store order', async () => {
    const a = await buildDsConsumerBlock(CONSUMER, fakeStore([component('Zeta'), component('Alpha')]));
    const b = await buildDsConsumerBlock(CONSUMER, fakeStore([component('Alpha'), component('Zeta')]));
    expect(a).toBe(b);
    expect(a.indexOf('Alpha')).toBeLessThan(a.indexOf('Zeta'));
  });

  it('caps the inventory at 60 and summarizes the rest', async () => {
    const many = Array.from({ length: 75 }, (_, i) => component(`C${String(i).padStart(3, '0')}`));
    const block = await buildDsConsumerBlock(CONSUMER, fakeStore(many));
    expect(block).toContain('… and 15 more');
    expect(block).toContain('C059');
    expect(block).not.toContain('C060');
  });

  it('degrades to a minimal block when the store is missing', async () => {
    const block = await buildDsConsumerBlock(CONSUMER, null);
    expect(block).toContain('`@acme/ui@1.2.0`');
    expect(block).toContain('inventory unavailable');
    expect(block).toContain('re-link');
  });

  it('degrades when the pinned version is gone or unpublished', async () => {
    const store = {
      getSession: async () => ({ id: SESSION_ID }),
      getVersionBySemver: async () => null,
      listComponents: async () => [],
    } as unknown as DesignSystemStore;
    const block = await buildDsConsumerBlock(CONSUMER, store);
    expect(block).toContain('inventory unavailable');
  });
});
