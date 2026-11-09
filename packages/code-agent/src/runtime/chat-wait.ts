import type { ChatCompletion } from '@mcp/session-storage/collaboration/network-types.js';
import type { WorkWaitResult } from '@mcp/agent-runtime-contracts';
import { rootChatId, type ChatCollaborationStore } from '@mcp/session-storage/collaboration/store.js';
import { registerWait } from '@mcp/session-storage/collaboration/wait-graph.js';

/** Read-only join. Cursor captures each target independently; timeout/abort only
 * release this waiter. Completion events remain available to future consumers. */
export async function waitChats(store: ChatCollaborationStore, actorSession: string, targets: string[],
  mode: 'any' | 'all' | 'idle', timeoutMs: number, cursor?: string, signal?: AbortSignal): Promise<WorkWaitResult<ChatCompletion>> {
  if (!targets.length || targets.length > 8 || new Set(targets).size !== targets.length || targets.includes(actorSession)) throw new Error('invalid_wait_targets');
  for (const id of targets) if (!await store.connected(actorSession, id)) throw new Error('scope_denied');
  let previous: Record<string, string> = {};
  if (cursor) {
    try {
      const value = JSON.parse(Buffer.from(cursor, 'base64url').toString());
      if (value.version !== 1 || !value.after || Object.keys(value.after).some(id => !targets.includes(id))) throw new Error();
      previous = value.after;
    } catch { return { schemaVersion: 1, reason: 'cursor_expired', items: [], cursor: null }; }
  }
  const edge = await registerWait(store.files, rootChatId(actorSession), targets.map(rootChatId), mode === 'any' ? 'any' : 'all', Date.now() + Math.min(60000, Math.max(0, timeoutMs)));
  try { return await new Promise((resolve, reject) => {
    let done = false, checking = false, dirty = false;
    const cleanup = () => { off(); clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const finish = (reason: WorkWaitResult<ChatCompletion>['reason'], items: ChatCompletion[] = []) => {
      if (done) return; done = true; cleanup();
      const after = { ...previous }; for (const row of items) after[row.sessionId] = row.runId;
      resolve({ schemaVersion: 1, reason, items, cursor: Buffer.from(JSON.stringify({ version: 1, after })).toString('base64url') });
    };
    const check = async () => {
      if (done) return; if (checking) { dirty = true; return; } checking = true;
      try {
        do {
          dirty = false;
          const rows: ChatCompletion[] = []; let idle = 0;
          for (const id of targets) {
            const events = await store.completions(id);
            const index = previous[id] ? events.findIndex(row => row.runId === previous[id]) : -1;
            if (previous[id] && index === -1) { finish('cursor_expired'); return; }
            rows.push(...events.slice(index + 1));
            if ((await store.participant(rootChatId(id)))?.state === 'idle') idle++;
          }
          if (mode === 'idle' && idle === targets.length) finish('idle', rows);
          else if (mode === 'any' && rows.length || mode === 'all' && new Set(rows.map(row => row.sessionId)).size === targets.length) finish('completed', rows);
          else if (await edge.cyclic()) finish('cycle_detected');
        } while (dirty && !done);
      } catch (error) { done = true; cleanup(); reject(error); }
      finally { checking = false; }
    };
    const off = store.subscribe(() => { void check(); });
    const timer = setTimeout(() => finish('timeout'), Math.min(60000, Math.max(0, timeoutMs)));
    const abort = () => finish('aborted');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort(); else void check();
  }); } finally { await edge.dispose(); }
}
