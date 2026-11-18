import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { FileSessionRepository, SessionLocator } from '../../index.js';
import { FsSessionStore } from '../fs-session-store.js';

it('flushes assistant metadata once while preserving the journal, usage and tool results after reopening', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turn-write-amplification-'));
  const project = join(root, 'project');
  await mkdir(project);
  const locator = new SessionLocator({ dataDir: join(root, 'data'), projectRootResolver: {
    resolveProjectRoot: () => project,
    listProjectRoots: () => [{ project_id: 1, root_path: project }],
  } });
  let metadataFlushes = 0;
  const repository = new FileSessionRepository({ locator, faultInjector: ({ point, path }) => {
    if (point === 'atomic:after-temp-fsync-before-rename' && path?.endsWith('session.json')) metadataFlushes++;
  } });
  let store = new FsSessionStore({ locator, repository });
  try {
    const session = await store.createSession({ project_id: 1, title: 'Durable turn', provider: 'test', model: 'test' });
    metadataFlushes = 0;
    await store.persistAssistantTurn({ session_id: session.id, operation_id: 'assistant-1',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'read-1', name: 'read_file', input: { path: 'foo.txt' } }] },
      usage: { input_tokens: 23, output_tokens: 7 },
      tool_calls: [{ tool_use_id: 'read-1', tool_name: 'read_file', args: { path: 'foo.txt' },
        result_text: 'saved result', is_error: false, duration_ms: 1, output_chars: 12, truncated: false }],
    });
    expect(metadataFlushes).toBe(1);
    expect(await store.getMetricsSummary(session.id)).toMatchObject({ turns: 1, tool_calls: 1, tokens: { input: 23, output: 7 } });
    await store.close();
    store = new FsSessionStore({ locator });
    const loaded = await store.loadSessionWithMessages(session.id);
    expect(loaded?.messages).toHaveLength(2);
    expect(JSON.stringify(loaded?.messages)).toContain('saved result');
    expect(await store.getMetricsSummary(session.id)).toMatchObject({ turns: 1, tool_calls: 1, tokens: { input: 23, output: 7 } });
  } finally {
    await store.close();
    if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith('turn-write-amplification-')) throw new Error('Unsafe fixture cleanup');
    await rm(root, { recursive: true, force: true });
  }
});
