import { afterEach, describe, expect, it } from 'vitest';
import type { DesignSystemStore } from '@mcp/store/design-system-store.js';
import { setDesignSystemStore } from '../store-binding.js';
import { buildDesignSystemConsumerTools } from '../consumer-tools.js';
import type { DsConsumerBinding } from '../consumer-resolve.js';

const BINDING: DsConsumerBinding = { sessionId: 3, packageName: '@acme/ui', semver: '1.2.0' };

const MANIFEST = JSON.stringify({
  manifest_version: '2',
  tokens: { color: { primary: '#111', accent: '#222' }, radius: '4px' },
  components: [
    { name: 'Button', description: 'Primary action button', css_classes: ['btn'], html: '<button class="btn">x</button>' },
  ],
});

const COMPONENTS = [
  {
    id: 1,
    version_id: 7,
    name: 'Card',
    kind: 'atom' as const,
    props_schema_json: null,
    example_code: null,
    created_at: 'x',
  },
  {
    id: 2,
    version_id: 7,
    name: 'Button',
    kind: 'atom' as const,
    props_schema_json: JSON.stringify({
      properties: { variant: { enum: ['primary', 'ghost'] }, disabled: { type: 'boolean' } },
    }),
    example_code: '<Button variant="primary">Go</Button>',
    created_at: 'x',
  },
];

function fakeStore(over: Partial<Record<'getSession' | 'getVersionBySemver' | 'listComponents', unknown>> = {}): DesignSystemStore {
  return {
    getSession: (id: number) => (id === 3 ? { id: 3, package_name: '@acme/ui', stack: 'react-ts' } : null),
    getVersionBySemver: (_id: number, semver: string) =>
      semver === '1.2.0'
        ? { id: 7, semver: '1.2.0', status: 'published', manifest_json: MANIFEST, docs_md: DOCS }
        : null,
    listComponents: () => COMPONENTS,
    ...over,
  } as unknown as DesignSystemStore;
}

const DOCS = [
  '# @acme/ui',
  'Intro paragraph.',
  '## Theming',
  'Use the CSS variables.',
  '## Setup',
  'Import the stylesheet once.',
].join('\n');

afterEach(() => setDesignSystemStore(null));

function tools() {
  const [components, component, docs] = buildDesignSystemConsumerTools(BINDING);
  return { components, component, docs };
}

const ctx = {} as never;

describe('ds_components', () => {
  it('errors when the store is not wired', async () => {
    setDesignSystemStore(null);
    const r = await tools().components.handler({}, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('not wired');
  });

  it('errors with the stale-link message when the session is gone', async () => {
    setDesignSystemStore(fakeStore({ getSession: () => null }));
    const r = await tools().components.handler({}, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('@acme/ui@1.2.0');
    expect(r.content).toContain('re-link');
  });

  it('lists the inventory sorted with props summary and tokens', async () => {
    setDesignSystemStore(fakeStore());
    const r = await tools().components.handler({}, ctx);
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('@acme/ui@1.2.0 — 2 component(s)');
    // Sorted A→Z within kind: Button before Card.
    expect(r.content.indexOf('Button')).toBeLessThan(r.content.indexOf('Card'));
    expect(r.content).toContain('variant: primary|ghost');
    expect(r.content).toContain('color.primary');
    expect(r.content).toContain('radius');
  });
});

describe('ds_component', () => {
  it('returns the full contract (import line, schema, example, manifest extras)', async () => {
    setDesignSystemStore(fakeStore());
    const r = await tools().component.handler({ name: 'Button' }, ctx);
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("import { Button } from '@acme/ui'");
    expect(r.content).toContain('Props schema:');
    expect(r.content).toContain('<Button variant="primary">Go</Button>');
    expect(r.content).toContain('Primary action button');
    expect(r.content).toContain('Rendered markup:');
  });

  it('matches case-insensitively and lists available names when missing', async () => {
    setDesignSystemStore(fakeStore());
    const okR = await tools().component.handler({ name: 'button' }, ctx);
    expect(okR.isError).toBeUndefined();
    const missR = await tools().component.handler({ name: 'Nope' }, ctx);
    expect(missR.isError).toBe(true);
    expect(missR.content).toContain('Card');
    expect(missR.content).toContain('Button');
  });

  it('requires the name argument', async () => {
    setDesignSystemStore(fakeStore());
    const r = await tools().component.handler({}, ctx);
    expect(r.isError).toBe(true);
  });
});

describe('ds_docs', () => {
  it('returns the whole doc when short', async () => {
    setDesignSystemStore(fakeStore());
    const r = await tools().docs.handler({}, ctx);
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('Intro paragraph.');
    expect(r.content).toContain('## Setup');
  });

  it('returns one section by heading (case-insensitive substring)', async () => {
    setDesignSystemStore(fakeStore());
    const r = await tools().docs.handler({ heading: 'theming' }, ctx);
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('Use the CSS variables.');
    expect(r.content).not.toContain('Import the stylesheet');
  });

  it('errors with the heading index when the section is missing', async () => {
    setDesignSystemStore(fakeStore());
    const r = await tools().docs.handler({ heading: 'zzz' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('Theming');
    expect(r.content).toContain('Setup');
  });

  it('returns a section index for long docs', async () => {
    const long = `# t\n${'x'.repeat(9_000)}\n## A\na\n## B\nb`;
    setDesignSystemStore(
      fakeStore({
        getVersionBySemver: () => ({ id: 7, semver: '1.2.0', status: 'published', manifest_json: null, docs_md: long }),
      }),
    );
    const r = await tools().docs.handler({}, ctx);
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('Sections:');
    expect(r.content).toContain('- A');
    expect(r.content).toContain('- B');
  });

  it('says so when the version shipped no docs', async () => {
    setDesignSystemStore(
      fakeStore({
        getVersionBySemver: () => ({ id: 7, semver: '1.2.0', status: 'published', manifest_json: null, docs_md: null }),
      }),
    );
    const r = await tools().docs.handler({}, ctx);
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('no docs.md');
  });
});
