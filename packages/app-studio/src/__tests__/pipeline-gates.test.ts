import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runAppStageGate, type AppStageGateInput } from '../pipeline/gates.js';
import { createPipelineState, replaceRoadmap } from '../pipeline/stages.js';
import { buildFeatureRoadmap } from '../pipeline/roadmap.js';
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

describe('design gate', () => {
  it('requires recorded screens and registry entries', async () => {
    const ws = makeWorkspace({ 'src/screens/registry.ts': "export const SCREENS = { 'outra': null };" });
    const gate = await runAppStageGate(input({ stage: 'design', workspaceDir: ws }));
    expect(gate.issues.join()).toContain('PainelScreen');
    expect(gate.issues.join()).toContain("missing screen id 'painel'");
  });

  it('passes with recorded screens + registry (runBuild off)', async () => {
    const ws = makeWorkspace({ 'src/screens/registry.ts': "export const SCREENS = { 'painel': null };" });
    const gate = await runAppStageGate(
      input({ stage: 'design', workspaceDir: ws, recorded: [{ name: 'PainelScreen', kind: 'screen' }] }),
    );
    expect(gate.ok).toBe(true);
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
