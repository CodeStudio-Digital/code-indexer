/**
 * End-to-end install/uninstall against a temp DB + temp data dir. Setting
 * MCP_INDEX_DB redirects both the database and the plugins dir (pluginsRoot
 * derives from the DB dir), so nothing touches the real ~/.mcp-code-indexer.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import { SkillStore } from '@mcp/store/skill-store.js';
import { McpServerStore } from '@mcp/store/mcp-server-store.js';
import { InstalledPluginStore } from '@mcp/store/installed-plugin-store.js';
import { installPlugin, uninstallPlugin } from '@mcp/plugin-host';

const NS = 'hello-plugin';
let dir: string;
let dbPath: string;
let fixtureDir: string;
const prevEnv = process.env.MCP_INDEX_DB;

function writeFixture(root: string): void {
  mkdirSync(join(root, 'skills', 'greeter'), { recursive: true });
  mkdirSync(join(root, 'commands'), { recursive: true });
  writeFileSync(
    join(root, 'plugin.json'),
    JSON.stringify({
      name: NS,
      version: '1.0.0',
      description: 'A test plugin',
      author: { name: 'Tester' },
    }),
  );
  writeFileSync(
    join(root, 'skills', 'greeter', 'SKILL.md'),
    '---\nname: greeter\ndescription: Greets people\n---\n\nSay hello nicely.',
  );
  writeFileSync(
    join(root, 'commands', 'wave.md'),
    '---\ndescription: Wave command\n---\n\nWave at the user.',
  );
  writeFileSync(
    join(root, '.mcp.json'),
    JSON.stringify({ mcpServers: { demo: { type: 'http', url: 'https://example.com/mcp' } } }),
  );
  writeFileSync(
    join(root, '.app.json'),
    JSON.stringify({
      commands: [{ id: 'hello-cmd', label: 'Say Hello' }],
      themes: [
        { id: 'hello-dark', label: 'Hello Dark', appearance: 'dark', tokens: { '--primary': '#abc' } },
      ],
    }),
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-plugin-test-'));
  dbPath = join(dir, 'test.db');
  process.env.MCP_INDEX_DB = dbPath;
  new CodeIndexDB(dbPath).close(); // create + migrate schema
  fixtureDir = join(dir, 'fixture');
  writeFixture(fixtureDir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  if (prevEnv === undefined) delete process.env.MCP_INDEX_DB;
  else process.env.MCP_INDEX_DB = prevEnv;
});

describe('installPlugin (local source)', () => {
  it('installs skills, MCP servers, and records the plugin', async () => {
    const result = await installPlugin({ source: { source: 'local', path: fixtureDir } });

    expect(result.namespace).toBe(NS);
    expect(result.skills.length).toBe(2); // SKILL.md + command
    expect(result.mcpServers.length).toBe(1);
    expect(result.contributions?.commands?.length).toBe(1);

    const skillStore = new SkillStore(dbPath);
    const skills = skillStore
      .listSkills({ source: 'imported' })
      .filter((s) => s.author === NS);
    skillStore.close();
    expect(skills.length).toBe(2);

    const mcpStore = new McpServerStore(dbPath);
    const servers = mcpStore
      .listServers()
      .filter((s) => (s.config as { installed_by_namespace?: string }).installed_by_namespace === NS);
    mcpStore.close();
    expect(servers.length).toBe(1);

    const pluginStore = new InstalledPluginStore(dbPath);
    const row = pluginStore.get(NS);
    pluginStore.close();
    expect(row?.version).toBe('1.0.0');
    expect(row?.enabled).toBe(true);
  });

  it('tears down everything on uninstall', async () => {
    await installPlugin({ source: { source: 'local', path: fixtureDir } });
    const res = await uninstallPlugin(NS);

    expect(res.skillsRemoved).toBe(2);
    expect(res.mcpRemoved).toBe(1);

    const skillStore = new SkillStore(dbPath);
    const remaining = skillStore
      .listSkills({ source: 'imported' })
      .filter((s) => s.author === NS);
    skillStore.close();
    expect(remaining.length).toBe(0);

    const pluginStore = new InstalledPluginStore(dbPath);
    expect(pluginStore.get(NS)).toBeNull();
    pluginStore.close();
  });

  it('rejects a double install without overwrite', async () => {
    await installPlugin({ source: { source: 'local', path: fixtureDir } });
    await expect(
      installPlugin({ source: { source: 'local', path: fixtureDir } }),
    ).rejects.toThrow(/already installed/);
  });

  it('replaces an existing install when overwrite is set', async () => {
    await installPlugin({ source: { source: 'local', path: fixtureDir } });
    const again = await installPlugin({
      source: { source: 'local', path: fixtureDir },
      overwrite: true,
    });
    expect(again.namespace).toBe(NS);
  });
});
