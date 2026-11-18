import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { FsSessionStore } from '../fs-session-store.js';
import type { AgentMessage } from '@mcp/provider-sdk';

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
    await store.close();
    store = open();
    const loaded = await store.loadSessionWithMessages(session.id);
    expect(loaded?.messages).toEqual([message]);
    const copy = await store.duplicateSession(session.id);
    expect((await store.loadSessionWithMessages(copy.id))?.messages).toEqual([message]);
    expect(JSON.stringify(loaded?.message_rows)).not.toContain('opaque-fixture');
  } finally {
    await store.close();
    const inside = relative(base, root);
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error('Unsafe fixture cleanup');
    await rm(root, { recursive: true, force: true });
  }
});
