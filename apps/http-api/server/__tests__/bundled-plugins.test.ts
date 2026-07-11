import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import { InstalledPluginStore } from '@mcp/store/installed-plugin-store.js';
import { installPlugin } from '@mcp/plugin-host';
import { seedBundledPlugins } from '../bundled-plugins.js';

const NS = 'provider-fixture';
const VERSION = '1.0.0';
const previousDb = process.env.MCP_INDEX_DB;
const previousBundledRoot = process.env.MCP_BUNDLED_PLUGINS_DIR;

let tempRoot: string;
let dbPath: string;
let bundledRoot: string;
let fixtureDir: string;
let installedDir: string;

function writeBundledFixture(): void {
  mkdirSync(join(fixtureDir, 'dist'), { recursive: true });
  writeFileSync(
    join(fixtureDir, 'plugin.json'),
    JSON.stringify({
      name: NS,
      version: VERSION,
      description: 'Bundled runtime fixture',
      author: { name: 'MCP' },
      apps: '.app.json',
    }),
  );
  writeFileSync(
    join(fixtureDir, '.app.json'),
    JSON.stringify({ worker: './dist/plugin.js', tools: [], permissions: { storage: true } }),
  );
  writeFileSync(
    join(fixtureDir, 'dist', 'plugin.js'),
    'export default { tools: [], runtimeFormat: 4 };\n',
  );
  writeFileSync(
    join(fixtureDir, 'dist', 'package.json'),
    JSON.stringify({ type: 'module', mcpPluginRuntimeFormat: 4 }),
  );
}

beforeEach(async () => {
  tempRoot = mkdtempSync(join(tmpdir(), 'bundled-plugin-esm-'));
  dbPath = join(tempRoot, 'test.db');
  bundledRoot = join(tempRoot, 'bundled');
  fixtureDir = join(bundledRoot, NS);
  installedDir = join(tempRoot, 'plugins', NS);
  process.env.MCP_INDEX_DB = dbPath;
  process.env.MCP_BUNDLED_PLUGINS_DIR = bundledRoot;
  new CodeIndexDB(dbPath).close();
  writeBundledFixture();
  await installPlugin({ source: { source: 'bundled', path: fixtureDir } });
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

afterAll(() => {
  if (previousDb === undefined) delete process.env.MCP_INDEX_DB;
  else process.env.MCP_INDEX_DB = previousDb;
  if (previousBundledRoot === undefined) delete process.env.MCP_BUNDLED_PLUGINS_DIR;
  else process.env.MCP_BUNDLED_PLUGINS_DIR = previousBundledRoot;
});

describe('seedBundledPlugins runtime format migration', () => {
  it('refreshes an older same-version runtime once', async () => {
    const marker = join(installedDir, 'dist', 'package.json');
    const sentinel = join(installedDir, 'keep-me.txt');
    writeFileSync(join(installedDir, 'dist', 'plugin.js'), 'export default { tools: [], runtimeFormat: 1 };\n');
    rmSync(marker);
    writeFileSync(sentinel, 'preserved');
    expect(existsSync(marker)).toBe(false);
    const grants = new InstalledPluginStore(dbPath);
    grants.setPermissionsGranted(NS, null);
    grants.close();

    await seedBundledPlugins();

    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({
      type: 'module',
      mcpPluginRuntimeFormat: 4,
    });
    expect(readFileSync(join(installedDir, 'dist', 'plugin.js'), 'utf8')).toContain('runtimeFormat: 4');
    expect(existsSync(sentinel)).toBe(false);

    const afterStore = new InstalledPluginStore(dbPath);
    const after = afterStore.get(NS);
    afterStore.close();
    expect(after?.enabled).toBe(true);
    expect(after?.permissions_granted).toBeNull();

    writeFileSync(sentinel, 'preserved after upgrade');
    const fixedTime = new Date('2000-01-01T00:00:00.000Z');
    utimesSync(marker, fixedTime, fixedTime);
    await seedBundledPlugins();
    expect(statSync(marker).mtimeMs).toBe(fixedTime.getTime());
    expect(readFileSync(sentinel, 'utf8')).toBe('preserved after upgrade');
  });

  it('upgrades files without re-enabling a disabled plugin', async () => {
    const marker = join(installedDir, 'dist', 'package.json');
    writeFileSync(join(installedDir, 'dist', 'plugin.js'), 'export default { tools: [], runtimeFormat: 1 };\n');
    rmSync(marker);
    const store = new InstalledPluginStore(dbPath);
    store.setEnabled(NS, false);
    store.close();

    await seedBundledPlugins();

    const afterStore = new InstalledPluginStore(dbPath);
    const after = afterStore.get(NS);
    afterStore.close();
    expect(after?.enabled).toBe(false);
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toMatchObject({
      type: 'module',
      mcpPluginRuntimeFormat: 4,
    });
  });
});
