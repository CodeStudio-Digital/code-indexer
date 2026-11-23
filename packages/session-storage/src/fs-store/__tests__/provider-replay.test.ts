import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { FsSessionStore } from '../fs-session-store.js';
import type { FsCoderTurnPayload } from '../types.js';
import { storedProviderReplay, type AgentMessage } from '@mcp/provider-sdk';

it('preserves opaque continuation across durable commits, reopen and copies without exposing it in chat rows', async () => {
  const base = resolve('.tmp/provider-replay-tests');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'fixture-'));
  const project = join(root, 'project');
  await mkdir(project);
  const open = () => FsSessionStore.fromRoots({ dataDir: join(root, 'data'), projectRootResolver: {
    resolveProjectRoot: (id) => id === 7 ? project : null,
    listProjectRoots: () => [{ project_id: 7, root_path: project }],
  } });
  let store = open();
  try {
    const session = await store.createSession({ project_id: 7, title: 'Replay fixture', provider: 'test', model: 'test' });
    const message: AgentMessage = { role: 'assistant', phase: 'final_answer', content: [{ type: 'text', text: 'ok' }],
      providerReplay: { format: 'openai-responses-v1', scope: 'account:model', messageDigest: 'digest',
        items: [{ type: 'reasoning', encrypted_content: 'opaque-fixture' }] } };
    await store.persistAssistantTurn({ session_id: session.id, message, usage: null, tool_calls: [] });
    const location = (await store.getSessionLocation(session.id))!;
    const cached = await store.repository.readWriterProjection(location, {
      create: () => ({ deferred: false }),
      apply(result, commit) {
        const replay = (commit.payload as unknown as FsCoderTurnPayload).messages[0]?.provider_replay;
        result.deferred = !!replay && typeof Object.getOwnPropertyDescriptor(replay, 'items')?.get === 'function';
      },
    });
    expect(cached.deferred).toBe(true);
    await store.close();
    store = open();
    const loaded = await store.loadSessionWithMessages(session.id);
    const { providerReplay, ...visible } = message;
    expect(loaded?.messages).toEqual([visible]);
    const bundle = (await store.getSessionLocation(session.id))!.bundle_path;
    expect(JSON.parse(await readFile(join(bundle, 'conversation.jsonl'), 'utf8'))).toEqual(visible);
    expect(await readFile(join(bundle, 'journal.jsonl'), 'utf8')).not.toContain('opaque-fixture');
    const copy = await store.duplicateSession(session.id);
    const cloned = await store.loadSessionWithMessages(copy.id, { forProvider: true });
    expect(cloned?.messages[0]?.[storedProviderReplay]?.items).toEqual(providerReplay?.items);
    const dir = join(bundle, 'provider_replay');
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    const file = join(dir, files[0]!);
    await rename(file, file + '.offline');
    await store.close();
    store = open();
    await store.repository.primeSession((await store.getSessionLocation(session.id))!);
    expect((await store.loadSessionWithMessages(session.id))?.messages).toEqual([visible]);
    const lazy = (await store.loadSessionWithMessages(session.id, { forProvider: true }))!.messages[0]!;
    expect(JSON.parse(JSON.stringify(lazy))).toEqual(visible);
    expect(lazy[storedProviderReplay]?.scope).toBe('account:model');
    expect(() => lazy[storedProviderReplay]?.items).toThrow();
    await writeFile(file, '{}');
    expect(() => lazy[storedProviderReplay]?.items).toThrow(/checksum/);
    await writeFile(file, await readFile(file + '.offline'));
    expect(lazy[storedProviderReplay]?.items).toEqual(providerReplay?.items);
    expect(JSON.stringify(loaded?.message_rows)).not.toContain('opaque-fixture');
  } finally {
    await store.close();
    const inside = relative(base, root);
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error('Unsafe fixture cleanup');
    await rm(root, { recursive: true, force: true });
  }
});
