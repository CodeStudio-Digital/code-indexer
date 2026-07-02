import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runStudioAudit, type StudioAuditInput } from '../studio-audit/index.js';

let dir: string | null = null;

const TOKENS_CSS = `:root {
  --color-primary: #1a73e8;
  --color-surface: #ffffff;
  --font-body: 'Inter', sans-serif;
  --radius-md: 8px;
}`;

const GOOD_BUTTON = `export function Button({ tone = 'primary', disabled }: { tone?: 'primary' | 'secondary'; disabled?: boolean }) {
  return (
    <button type="button" disabled={disabled} className="btn focus-visible:ring" style={{ background: 'var(--color-primary)' }}>
      ok
    </button>
  );
}`;

const REGISTRY = `import { Button } from '@ds';
export const demos = {
  Button: { render: () => (<><Button tone="primary" /><Button tone="secondary" /><Button disabled /></>) },
};`;

const INDEX_TS = `export { Button } from './components/Button.js';`;

const DOCS_MD = `# @acme/ds

## Button

Theme-driven button. Tones primary/secondary, disabled state, keyboard focus.
Consume tokens only; never hard-code colors. More prose so the section is long
enough to count as substantial documentation for the depth check heuristics.

\`\`\`tsx
<Button tone="primary">Buy</Button>
\`\`\`
`;

function makeWorkspace(overrides: Record<string, string> = {}): string {
  dir = mkdtempSync(join(tmpdir(), 'studio-audit-'));
  const files: Record<string, string> = {
    'pkg/src/tokens.css': TOKENS_CSS,
    'pkg/src/index.ts': INDEX_TS,
    'pkg/src/components/Button.tsx': GOOD_BUTTON,
    'pkg/docs.md': DOCS_MD,
    'app/src/gallery/registry.tsx': REGISTRY,
    'import/css/theme.css': '.btn-primary { background-color: #1a73e8; } body { font-family: "Inter", sans-serif; }',
    ...overrides,
  };
  for (const [rel, contents] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, contents, 'utf8');
  }
  return dir;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

const BUTTON_RECORDED = {
  name: 'Button',
  kind: 'atom',
  props_schema_json: JSON.stringify({ properties: { tone: { values: ['primary', 'secondary'] } } }),
};

function input(workspaceDir: string, over: Partial<StudioAuditInput> = {}): StudioAuditInput {
  return {
    workspaceDir,
    stack: 'react-ts',
    mode: 'fidelity',
    recorded: [BUTTON_RECORDED],
    scope: 'publish',
    ...over,
  };
}

describe('runStudioAudit — healthy workspace', () => {
  it('passes every check on the fixture', async () => {
    const result = await runStudioAudit(input(makeWorkspace()));
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.metrics.theme_fidelity).toBe(1);
  });
});

describe('token_coverage', () => {
  it('flags raw hex with file:line and approves hsl(var(--x))', async () => {
    const ws = makeWorkspace({
      'pkg/src/components/Button.tsx':
        `export const Button = () => <button type="button" style={{ color: '#ff0000', border: 'hsl(var(--ring))' }} className="focus-visible:ring" />;`,
    });
    const result = await runStudioAudit(input(ws, { checks: ['token_coverage'] }));
    expect(result.ok).toBe(false);
    const hex = result.errors.filter((e) => e.code === 'token_coverage.hex_literal');
    expect(hex).toHaveLength(1);
    expect(hex[0].file).toBe('pkg/src/components/Button.tsx');
    expect(hex[0].line).toBeGreaterThan(0);
  });

  it('flags Tailwind arbitrary colors', async () => {
    const ws = makeWorkspace({
      'pkg/src/components/Button.tsx': `export const Button = () => <button type="button" className="bg-[#00aaff] focus-visible:ring" />;`,
    });
    const result = await runStudioAudit(input(ws, { checks: ['token_coverage'] }));
    expect(result.errors.some((e) => e.code === 'token_coverage.arbitrary_tw')).toBe(true);
  });
});

describe('theme_fidelity', () => {
  it('fidelity: off-palette saturated token is an error naming the nearest theme color', async () => {
    const ws = makeWorkspace({
      'pkg/src/tokens.css': TOKENS_CSS.replace('#1a73e8', '#7b1fa2'), // roxo, tema é azul
    });
    const result = await runStudioAudit(input(ws, { checks: ['theme_fidelity'] }));
    expect(result.ok).toBe(false);
    expect(result.errors[0].code).toBe('theme_fidelity.off_palette');
    expect(result.errors[0].message).toContain('--color-primary');
    expect(result.errors[0].message).toContain('#1a73e8');
  });

  it('creative: same drift is a single adherence warning, never blocking', async () => {
    const ws = makeWorkspace({
      'pkg/src/tokens.css': TOKENS_CSS.replace('#1a73e8', '#7b1fa2'),
    });
    const result = await runStudioAudit(input(ws, { mode: 'creative', checks: ['theme_fidelity'] }));
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.code === 'theme_fidelity.adherence')).toBe(true);
  });

  it('neutral tokens (white/gray) are exempt', async () => {
    const result = await runStudioAudit(input(makeWorkspace(), { checks: ['theme_fidelity'] }));
    expect(result.errors).toEqual([]);
  });
});

describe('gallery_coverage', () => {
  it('unrecorded export: warning at stage scope, error at publish scope', async () => {
    const ws = makeWorkspace({
      'pkg/src/index.ts': `${INDEX_TS}\nexport { Badge } from './components/Badge.js';`,
    });
    const stage = await runStudioAudit(input(ws, { scope: 'stage', checks: ['gallery_coverage'] }));
    expect(stage.warnings.some((w) => w.code === 'gallery.unrecorded_export')).toBe(true);
    expect(stage.errors.some((e) => e.code === 'gallery.unrecorded_export')).toBe(false);

    const publish = await runStudioAudit(input(ws, { checks: ['gallery_coverage'] }));
    expect(publish.errors.some((e) => e.code === 'gallery.unrecorded_export' && e.message.includes('Badge'))).toBe(true);
  });

  it('recorded component without a demo is an error', async () => {
    const ws = makeWorkspace({
      'app/src/gallery/registry.tsx': `export const demos = { };`,
    });
    const result = await runStudioAudit(input(ws, { checks: ['gallery_coverage'] }));
    expect(result.errors.some((e) => e.code === 'gallery.demo_missing')).toBe(true);
  });
});

describe('variant_coverage', () => {
  it('a demo rendering 1 of 2+ enum values is an error', async () => {
    const ws = makeWorkspace({
      'app/src/gallery/registry.tsx': `export const demos = {
  Button: { render: () => <Button tone="primary" /> },
};`,
    });
    const result = await runStudioAudit(input(ws, { checks: ['variant_coverage', 'gallery_coverage'], scope: 'stage' }));
    expect(result.errors.some((e) => e.code === 'variants.insufficient')).toBe(true);
  });
});

describe('docs_depth', () => {
  it('missing section is an error at publish; thin/no-example are warnings', async () => {
    const ws = makeWorkspace({ 'pkg/docs.md': '# Docs\n\n## Other\ntext' });
    const result = await runStudioAudit(input(ws, { checks: ['docs_depth'] }));
    expect(result.errors.some((e) => e.code === 'docs.section_missing')).toBe(true);
  });
});

describe('a11y', () => {
  it('clickable div without semantics and img without alt are errors', async () => {
    const ws = makeWorkspace({
      'pkg/src/components/Card.tsx':
        `export const Card = () => <div onClick={() => {}}><img src="x.png" /></div>;`,
    });
    const result = await runStudioAudit(input(ws, { checks: ['a11y'] }));
    expect(result.errors.some((e) => e.code === 'a11y.clickable_div')).toBe(true);
    expect(result.errors.some((e) => e.code === 'a11y.img_no_alt')).toBe(true);
  });

  it('dialog-like component needs role="dialog"/aria-modal', async () => {
    const ws = makeWorkspace({
      'pkg/src/components/Dialog.tsx': `export const Dialog = () => <div className="overlay">content</div>;`,
    });
    const result = await runStudioAudit(input(ws, { checks: ['a11y'] }));
    expect(result.errors.some((e) => e.code === 'a11y.dialog_semantics')).toBe(true);
  });
});
