import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runAppStageGate, type AppStageGateInput } from '../pipeline/gates.js';
import { createPipelineState, replaceRoadmap } from '../pipeline/stages.js';
import { buildFeatureRoadmap } from '../pipeline/roadmap.js';
import { dataModelFingerprint, type AppBuildTaskKind, type AppUxBrief, type AppWireframePlan } from '../experience/types.js';
import { recordTddCycle } from '../architecture/tdd-cycles.js';
import { writeDbStatus, writeDeployStatus } from '../status-files.js';
import { makeSpec } from './fixtures.js';

let dir: string | null = null;

function makeWorkspace(files: Record<string, string>): string {
  dir = mkdtempSync(join(tmpdir(), 'app-gates-'));
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

function input(
  partial: Partial<AppStageGateInput> & Pick<AppStageGateInput, 'stage' | 'workspaceDir'>,
): AppStageGateInput {
  const spec = partial.spec === undefined ? makeSpec() : partial.spec;
  const state = createPipelineState();
  if (spec) replaceRoadmap(state, buildFeatureRoadmap(spec));
  return { state, spec, recorded: [], runBuild: false, ...partial };
}

const WRANGLER_OK = `{
  // managed header
  "name": "meu-app",
  "main": "worker/index.ts",
  "d1_databases": [{ "binding": "DB", "database_name": "meu-app-db", "database_id": "X" }]
}`;

function experienceFixtures() {
  const spec = makeSpec();
  const fingerprint = dataModelFingerprint(spec);
  const ux: AppUxBrief = {
    v: 1, spec_revision_id: 1, architecture_revision_id: 2, data_fingerprint: fingerprint,
    summary: 'Direção operacional clara para acompanhar pedidos.', selected_direction_id: 'operacional',
    directions: [
      { id: 'operacional', name: 'Operacional', rationale: 'Prioriza decisões rápidas.', palette: ['#ffffff', '#111827', '#2563eb'], typography: 'Inter', density: 'compact' },
      { id: 'acolhedora', name: 'Acolhedora', rationale: 'Aproxima a marca do público.', palette: ['#fff7ed', '#1f2937', '#16a34a'], typography: 'Source Sans 3', density: 'comfortable' },
      { id: 'editorial', name: 'Editorial', rationale: 'Valoriza leitura e hierarquia.', palette: ['#f8fafc', '#0f172a', '#db2777'], typography: 'IBM Plex Sans', density: 'spacious' },
    ],
    tokens: { background: '#ffffff', surface: '#f8fafc', text: '#111827', muted: '#64748b', primary: '#2563eb', secondary: '#0f766e', accent: '#db2777', success: '#16a34a', warning: '#d97706', danger: '#dc2626', font_display: 'Inter', font_body: 'Inter', radius: '6px', spacing: '4px', density: 'compact', motion: '150ms ease' },
    navigation: 'Barra lateral com contexto persistente.', principles: ['clareza', 'consistência', 'feedback imediato'], constraints: ['Não depender somente de cor.'], rejected_directions: [],
    accessibility: { standard: 'WCAG 2.2 AA', contrast: '4.5:1', keyboard: 'Toda ação por teclado', focus: 'Foco visível', reduced_motion: 'Respeitar prefers-reduced-motion' }, references: [],
  };
  const kinds: AppBuildTaskKind[] = ['test-red', 'mock-contract', 'screen', 'responsive', 'accessibility', 'test-green', 'preview'];
  const tasks = kinds.map((kind, index) => ({ id: `painel-${kind}`, group_id: 'pedidos', screen_id: 'painel', kind, title: `${kind} do painel`, sequence: index + 1, complexity: 'small' as const, depends_on: index ? [`painel-${kinds[index - 1]}`] : [], tdd_case_ids: ['wf-painel'], entity_names: ['pedidos'], source_ids: ['feature:gestao-pedidos'] }));
  const wireframe: AppWireframePlan = {
    v: 1, spec_revision_id: 1, architecture_revision_id: 2, ux_revision_id: 3, data_fingerprint: fingerprint, summary: 'Fluxo de gestão de pedidos.',
    flows: [{ id: 'gerir-pedidos', name: 'Gerir pedidos', actor: 'Dona', goal: 'Criar e acompanhar pedidos', entry_screen_id: 'painel', source_ids: ['feature:gestao-pedidos'], steps: [{ id: 'abrir', screen_id: 'painel', action: 'Abrir painel', result: 'Pedidos visíveis', reads: ['pedidos'], writes: [], next_step_ids: [] }] }],
    screens: [{ screen_id: 'painel', route: '/', flow_ids: ['gerir-pedidos'], hierarchy: ['Painel', 'Lista'], regions: [{ id: 'principal', purpose: 'Acompanhar pedidos', components: ['Tabela', 'Botão novo'] }], actions: ['Criar pedido'], data_bindings: [{ entity: 'pedidos', fields: ['cliente', 'total'], purpose: 'Listar pedidos', fixture_scenario: 'Lista preenchida e vazia' }], states: ['loading', 'populated', 'empty', 'error', 'forbidden'], responsive: 'Tabela vira lista no mobile.', accessibility: ['Foco visível', 'Cabeçalhos associados'] }],
    tdd_cases: [{ id: 'wf-painel', title: 'Mostra pedidos', architecture_case_ids: [], source_ids: ['feature:gestao-pedidos'], flow_ids: ['gerir-pedidos'], screen_ids: ['painel'], preconditions: ['Seed carregado'], steps: ['Abrir /'], expected: 'Pedidos aparecem' }],
    build_groups: [{ id: 'pedidos', name: 'Fluxo de pedidos', goal: 'Entregar gestão de pedidos', sequence: 1, complexity: 'medium', flow_ids: ['gerir-pedidos'], screen_ids: ['painel'], depends_on: [], task_ids: tasks.map((task) => task.id) }], tasks,
  };
  return { spec, ux, wireframe };
}

describe('discovery gate', () => {
  it('fails without a spec and surfaces validator issues', async () => {
    const ws = makeWorkspace({});
    const noSpec = await runAppStageGate(input({ stage: 'discovery', workspaceDir: ws, spec: null }));
    expect(noSpec.ok).toBe(false);
    expect(noSpec.issues[0]).toContain('app_save_spec');

    const bad = makeSpec({ screens: [] });
    const gate = await runAppStageGate(input({ stage: 'discovery', workspaceDir: ws, spec: bad }));
    expect(gate.ok).toBe(false);
    expect(gate.issues.join()).toContain('at least 1 screen');
  });

  it('passes with a valid spec', async () => {
    const ws = makeWorkspace({});
    expect((await runAppStageGate(input({ stage: 'discovery', workspaceDir: ws }))).ok).toBe(true);
  });
});

describe('database gate', () => {
  it('passes untouched when the spec needs no database', async () => {
    const ws = makeWorkspace({});
    const spec = makeSpec({ database: { required: false, entities: [] } });
    expect((await runAppStageGate(input({ stage: 'database', workspaceDir: ws, spec }))).ok).toBe(true);
  });

  it('requires migrations, entity tables, seeds and a local apply', async () => {
    const ws = makeWorkspace({});
    const empty = await runAppStageGate(input({ stage: 'database', workspaceDir: ws }));
    expect(empty.issues.join()).toContain('migrations/ has no .sql');

    writeFileSync(join(ws, 'migrations', '..', '.keep'), '');
    mkdirSync(join(ws, 'migrations'), { recursive: true });
    writeFileSync(join(ws, 'migrations', '0001_init.sql'), 'CREATE TABLE outra (id INTEGER);', 'utf8');
    const noTable = await runAppStageGate(input({ stage: 'database', workspaceDir: ws }));
    expect(noTable.issues.join()).toContain("CREATE TABLE for entity 'pedidos'");
    expect(noTable.issues.join()).toContain('seeds/seed.sql');
    expect(noTable.issues.join()).toContain('app_provision_db');

    writeFileSync(join(ws, 'migrations', '0002_pedidos.sql'), 'CREATE TABLE IF NOT EXISTS "pedidos" (id INTEGER);');
    mkdirSync(join(ws, 'seeds'), { recursive: true });
    writeFileSync(join(ws, 'seeds', 'seed.sql'), "INSERT INTO pedidos VALUES (1);");
    // Seed present but not yet loaded → gate still fails until app_provision_db runs it.
    writeDbStatus(ws, {
      engine: 'd1',
      local_ready: true,
      applied: ['0001_init.sql', '0002_pedidos.sql'],
      last_apply_at: 'now',
    });
    expect((await runAppStageGate(input({ stage: 'database', workspaceDir: ws }))).issues.join()).toContain(
      'Seed data not loaded',
    );
    // With seeded:true the gate passes.
    writeDbStatus(ws, {
      engine: 'd1',
      local_ready: true,
      applied: ['0001_init.sql', '0002_pedidos.sql'],
      seeded: true,
      last_apply_at: 'now',
    });
    expect((await runAppStageGate(input({ stage: 'database', workspaceDir: ws }))).ok).toBe(true);

    writeDbStatus(ws, {
      engine: 'd1',
      local_ready: true,
      applied: ['0001_init.sql', '0002_pedidos.sql'],
      seeded: true,
      last_error_phase: 'seed',
      last_error: 'example row violates a foreign key',
      last_apply_at: 'now',
    });
    expect((await runAppStageGate(input({ stage: 'database', workspaceDir: ws }))).issues.join()).toContain(
      'seed phase failed',
    );
  });

  it('flags a seed file with no INSERT statements (only comments)', async () => {
    const ws = makeWorkspace({
      'migrations/0001_init.sql': 'CREATE TABLE IF NOT EXISTS "pedidos" (id INTEGER);',
      'seeds/seed.sql': '-- só um comentário, sem linhas de exemplo\n',
    });
    writeDbStatus(ws, { engine: 'd1', local_ready: true, applied: ['0001_init.sql'], last_apply_at: 'now' });
    expect((await runAppStageGate(input({ stage: 'database', workspaceDir: ws }))).issues.join()).toContain(
      'no example rows',
    );
  });

  it('flags migrations missing from the applied list', async () => {
    const ws = makeWorkspace({
      'migrations/0001_init.sql': 'CREATE TABLE pedidos (id INTEGER);',
      'seeds/seed.sql': 'INSERT INTO pedidos VALUES (1);',
    });
    writeDbStatus(ws, { engine: 'd1', local_ready: true, applied: [], last_apply_at: 'now' });
    const gate = await runAppStageGate(input({ stage: 'database', workspaceDir: ws }));
    expect(gate.issues.join()).toContain('Migrations not applied locally: 0001_init.sql');
  });
});

describe('experience gates', () => {
  it('accepts a complete UX brief and rejects a stale data fingerprint', async () => {
    const { spec, ux } = experienceFixtures();
    const ws = makeWorkspace({});
    const valid = await runAppStageGate(input({ stage: 'ux', workspaceDir: ws, spec, ux, currentSpecRevisionId: 1, currentArchitectureRevisionId: 2 }));
    expect(valid.ok).toBe(true);
    const stale = await runAppStageGate(input({ stage: 'ux', workspaceDir: ws, spec, ux: { ...ux, data_fingerprint: 'old-data' }, currentSpecRevisionId: 1, currentArchitectureRevisionId: 2 }));
    expect(stale.issues.join('\n')).toContain('stale against the current data model');
  });

  it('audits real bindings and revision links before accepting wireframes', async () => {
    const { spec, wireframe } = experienceFixtures();
    const ws = makeWorkspace({});
    const valid = await runAppStageGate(input({ stage: 'wireframe', workspaceDir: ws, spec, uxStatus: 'approved', wireframe, currentSpecRevisionId: 1, currentArchitectureRevisionId: 2, currentUxRevisionId: 3 }));
    expect(valid.ok).toBe(true);
    const invalid = { ...wireframe, screens: wireframe.screens.map((screen) => ({ ...screen, data_bindings: [{ ...screen.data_bindings[0]!, fields: ['missing_column'] }] })) };
    const gate = await runAppStageGate(input({ stage: 'wireframe', workspaceDir: ws, spec, uxStatus: 'approved', wireframe: invalid, currentSpecRevisionId: 1, currentArchitectureRevisionId: 2, currentUxRevisionId: 3 }));
    expect(gate.issues.join('\n')).toContain("unknown field 'pedidos.missing_column'");
  });
});

describe('design gate', () => {
  it('requires recorded screens and registry entries', async () => {
    const ws = makeWorkspace({ 'src/screens/registry.ts': "export const SCREENS = { 'outra': null };" });
    const gate = await runAppStageGate(input({ stage: 'design', workspaceDir: ws }));
    expect(gate.issues.join()).toContain('PainelScreen');
    expect(gate.issues.join()).toContain("missing screen id 'painel'");
  });

  it('passes with recorded screens + registry (runBuild off)', async () => {
    const { spec, ux, wireframe } = experienceFixtures();
    const ws = makeWorkspace({
      'src/screens/registry.ts': "export const SCREENS = { 'painel': null };",
      'src/styles/tokens.css': `:root { --background: ${ux.tokens.background}; --surface: ${ux.tokens.surface}; --primary: ${ux.tokens.primary}; --text: ${ux.tokens.text}; --font-body: ${ux.tokens.font_body}; }`,
      'tests/e2e/painel.spec.ts': "test('wf-painel', async () => {});",
    });
    recordTddCycle(ws, { caseIds: ['wf-painel'], script: 'test:e2e', phase: 'red', output: 'expected failure' });
    recordTddCycle(ws, { caseIds: ['wf-painel'], script: 'test:e2e', phase: 'green', output: 'passed' });
    const gate = await runAppStageGate(
      input({ stage: 'design', workspaceDir: ws, spec, ux, uxStatus: 'approved', wireframe, wireframeStatus: 'approved', buildGroups: [{ group_id: 'pedidos', status: 'approved' }], buildTasks: wireframe.tasks.map((task) => ({ task_id: task.id, status: 'done' })), recorded: [{ name: 'PainelScreen', kind: 'screen' }] }),
    );
    expect(gate.ok).toBe(true);
  });

  it('does not treat missing group and task evidence as completed work', async () => {
    const { spec, ux, wireframe } = experienceFixtures();
    const ws = makeWorkspace({ 'src/screens/registry.ts': "export const SCREENS = { 'painel': null };", 'src/styles/tokens.css': `${ux.tokens.background} ${ux.tokens.surface} ${ux.tokens.primary} ${ux.tokens.text} ${ux.tokens.font_body}` });
    const gate = await runAppStageGate(input({ stage: 'design', workspaceDir: ws, spec, ux, uxStatus: 'approved', wireframe, wireframeStatus: 'approved', recorded: [{ name: 'PainelScreen', kind: 'screen' }] }));
    expect(gate.issues.join('\n')).toContain('Build groups waiting for user approval: pedidos');
    expect(gate.issues.join('\n')).toContain('Build tasks without completion evidence');
  });
});

describe('backend gate', () => {
  it('flags unrecorded APIs, entities without routes and lingering mock imports', async () => {
    const ws = makeWorkspace({
      'worker/index.ts': "import { Hono } from 'hono'; // no entity routes yet",
      'src/screens/PainelScreen.tsx': "import { pedidos } from '../lib/mock';",
    });
    const gate = await runAppStageGate(input({ stage: 'backend', workspaceDir: ws }));
    const text = gate.issues.join('\n');
    expect(text).toContain("API deliverables not recorded");
    expect(text).toContain("Entity 'pedidos' has no route");
    expect(text).toContain('lib/mock');
  });

  it('with auth: requires worker/auth.ts, better-auth tables and guards', async () => {
    const spec = makeSpec({
      auth: { enabled: true, methods: ['password'], protected_screen_ids: ['painel'] },
    });
    const ws = makeWorkspace({
      'worker/api.ts': 'const q = `SELECT * FROM pedidos`;',
      'migrations/0001_init.sql': 'CREATE TABLE pedidos (id INTEGER);',
    });
    const gate = await runAppStageGate(
      input({ stage: 'backend', workspaceDir: ws, spec, recorded: [{ name: 'pedidos', kind: 'api' }] }),
    );
    const text = gate.issues.join('\n');
    expect(text).toContain('worker/auth.ts');
    expect(text).toContain('better-auth tables missing');
    expect(text).toContain('RequireAuth');
  });
});

describe('review gate', () => {
  it('surfaces security audit errors and missing REVIEW.md', async () => {
    const ws = makeWorkspace({ '.gitignore': 'node_modules\n' });
    const gate = await runAppStageGate(input({ stage: 'review', workspaceDir: ws }));
    const text = gate.issues.join('\n');
    expect(text).toContain('.dev.vars');
    expect(text).toContain('REVIEW.md');
  });

  it('passes a clean workspace (runBuild off)', async () => {
    const ws = makeWorkspace({
      '.gitignore': 'node_modules\n.dev.vars\n',
      'wrangler.jsonc': WRANGLER_OK,
      'REVIEW.md': '# Checagem de qualidade\nTudo certo.',
    });
    expect((await runAppStageGate(input({ stage: 'review', workspaceDir: ws }))).ok).toBe(true);
  });
});

describe('launch gate', () => {
  it('fails before deploy and passes once deploy.json records a healthy URL', async () => {
    const ws = makeWorkspace({});
    expect((await runAppStageGate(input({ stage: 'launch', workspaceDir: ws }))).ok).toBe(false);

    writeDeployStatus(ws, { url: 'https://meu-app.acme.workers.dev', health_ok: true });
    expect((await runAppStageGate(input({ stage: 'launch', workspaceDir: ws }))).ok).toBe(true);
  });
});
