import { describe, expect, it } from 'vitest';
import { publishServerStatus, subscribeServerStatus } from '../server-status-hub.js';

describe('server-status-hub replay', () => {
  it('replays the latest state when ready happened before subscription', async () => {
    const projectId = 91_001;
    publishServerStatus(projectId, { languageId: 'php', state: 'starting' });
    publishServerStatus(projectId, { languageId: 'php', state: 'ready' });

    const iterator = subscribeServerStatus(projectId)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { languageId: 'php', state: 'ready' },
    });
    await iterator.return?.();
  });

  it('coalesces replay independently per language', async () => {
    const projectId = 91_002;
    publishServerStatus(projectId, { languageId: 'java', state: 'ready' });
    publishServerStatus(projectId, { languageId: 'php', state: 'failed', reason: 'boom' });

    const iterator = subscribeServerStatus(projectId)[Symbol.asyncIterator]();
    const frames = [(await iterator.next()).value, (await iterator.next()).value];
    expect(frames).toEqual(expect.arrayContaining([
      expect.objectContaining({ languageId: 'java', state: 'ready' }),
      expect.objectContaining({ languageId: 'php', state: 'failed' }),
    ]));
    await iterator.return?.();
  });
});

