import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import { AppSettingsStore } from '@mcp/store/app-settings-store.js';
import { getSettingDef } from '@mcp/store/app-settings-catalog.js';
import type { ControlPlaneRunContext } from '@mcp/store/control-plane/index.js';
import { nativeCoderDevelopmentConfig } from '../sse/native-coder-worker-handle.js';

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof DatabaseType;
const roots: string[] = [], key = 'CODESTUDIO_NATIVE_CODER_DEV';
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep + 'native-preview-settings-')) throw new Error('Unexpected fixture cleanup root');
    await rm(root, { recursive: true, force: true });
  }
});

it('exposes a persisted opt-in that survives restart and keeps native sessions from falling back', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-preview-settings-')); roots.push(root);
  const dbPath = join(root, 'profile.db'), db = new Database(dbPath);
  db.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)'); db.close();
  const definition = getSettingDef(key);
  expect(definition).toMatchObject({ type: 'bool', category: 'agent', default: '0', restartNeeded: true });
  vi.stubEnv(key, '0');
  const sessionId = randomUUID(), input = { sessionId, dbPath, workerFile: resolve('dist/apps/http-api/workers/coder-worker.js'),
    projectRoot: root, context: { sessionId } as ControlPlaneRunContext };
  expect(await nativeCoderDevelopmentConfig(input)).toBeUndefined();
  const setting = new AppSettingsStore(dbPath);
  try { setting.set(key, '1'); } finally { setting.close(); }
  delete process.env[key];
  const reopened = new AppSettingsStore(dbPath);
  try { expect(reopened.applyToProcessEnv().applied).toBe(1); } finally { reopened.close(); }
  if (process.platform === 'win32' && process.arch === 'x64') {
    expect(await nativeCoderDevelopmentConfig(input)).toMatchObject({ mode: 'test', context: input.context,
      sessionRoot: join(root, 'native-sessions'), workspaceRoot: root });
  } else await expect(nativeCoderDevelopmentConfig(input)).rejects.toThrow('Windows x64');
  vi.stubEnv(key, '0');
  const nativeSession = join(root, 'native-sessions', sessionId);
  await mkdir(nativeSession, { recursive: true }); await writeFile(join(nativeSession, 'session.json'), '{}');
  await expect(nativeCoderDevelopmentConfig(input)).rejects.toThrow('requires the native runtime');
});
