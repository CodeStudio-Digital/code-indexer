import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionWorkbenchCommand } from '@mcp/api-bus';
import { asSessionId } from '@mcp/session-storage';
import type { ServerDeps } from '../../../deps.js';
import { mountConversationFormatGuard } from '../conversation-format-guard.js';
import { mountSessionWorkbenchRoutes } from '../session-workbench/routes.js';

const retiredId = asSessionId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
const currentId = asSessionId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
const commandId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
let root: string;
let marker: string;
let deps: ServerDeps;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'conversation-format-routes-'));
  marker = join(root, 'native-sessions', retiredId, 'session.json');
  await mkdir(join(root, 'native-sessions', retiredId), { recursive: true });
  await writeFile(marker, 'authoritative historical journal');
  deps = { config: { dbPath: join(root, 'app.db') } } as ServerDeps;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function guardedApp() {
  const app = new Hono();
  const handler = vi.fn(() => undefined);
  mountConversationFormatGuard(app, deps);
  app.all('/api/coder/*', (c) => { handler(); return c.json({ ok: true }); });
  return { app, handler };
}

function commandApp() {
  const app = new Hono();
  const execute = vi.fn(async (command: SessionWorkbenchCommand) => ({
    commandId: command.commandId, sessionId: command.sessionId, ok: true as const, revision: 1,
  }));
  const batch = vi.fn(async (commands: SessionWorkbenchCommand[]) => Promise.all(commands.map(execute)));
  mountSessionWorkbenchRoutes(app, deps, {
    service: { listSessions: vi.fn(), bootstrap: vi.fn() },
    commands: { execute, batch },
  });
  return { app, execute, batch };
}

describe('retired conversation HTTP boundary', () => {
  it.each([
    ['GET', `/api/coder/sessions/${retiredId}/messages`],
    ['GET', `/api/coder/sessions/${retiredId.replace('a', '%61')}/messages`],
    ['POST', `/api/coder/sessions/${retiredId}/stream`],
    ['POST', `/api/coder/sessions/${retiredId}/fork`],
    ['GET', `/api/coder/session-workbench/sessions/${retiredId}/context`],
  ])('rejects %s %s before reading or mutating a partial transcript', async (method, path) => {
    const { app, handler } = guardedApp();
    const response = await app.request(path, { method });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'RETIRED_CONVERSATION_FORMAT', retryable: false });
    expect(handler).not.toHaveBeenCalled();
    expect(await readFile(marker, 'utf8')).toBe('authoritative historical journal');
  });

  it('allows current conversations, collection routes, and retired metadata management', async () => {
    const { app, handler } = guardedApp();
    for (const [method, path] of [
      ['GET', `/api/coder/sessions/${currentId}/messages`],
      ['POST', `/api/coder/sessions/${currentId}/stream`],
      ['GET', '/api/coder/sessions/global'],
      ['PATCH', `/api/coder/sessions/${retiredId}`],
      ['DELETE', `/api/coder/sessions/${retiredId}`],
    ]) {
      expect((await app.request(path, { method })).status).toBe(200);
    }
    expect(handler).toHaveBeenCalledTimes(5);
  });

  it('rejects duplication through a command before executing it', async () => {
    const { app, execute } = commandApp();
    const response = await app.request('/api/coder/session-workbench/commands', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commandId, sessionId: retiredId, type: 'duplicate' }),
    });
    expect(response.status).toBe(409);
    expect(execute).not.toHaveBeenCalled();
  });

  it('preflights duplication before any earlier command in a batch can mutate metadata', async () => {
    const { app, execute, batch } = commandApp();
    const response = await app.request('/api/coder/session-workbench/commands/batch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands: [
        { commandId, sessionId: retiredId, type: 'rename', title: 'Renamed' },
        { commandId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', sessionId: retiredId, type: 'duplicate' },
      ] }),
    });
    expect(response.status).toBe(409);
    expect(batch).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('allows archiving historical conversations and duplicating current conversations', async () => {
    const { app, execute } = commandApp();
    for (const command of [
      { commandId, sessionId: retiredId, type: 'set_archived', archived: true },
      { commandId, sessionId: currentId, type: 'duplicate' },
    ]) {
      const response = await app.request('/api/coder/session-workbench/commands', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command),
      });
      expect(response.status).toBe(200);
    }
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
