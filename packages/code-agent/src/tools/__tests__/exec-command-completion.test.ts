/**
 * Completion-oriented waiting for persistent commands.
 *
 * The 3.16.24 Ky run spent four model rounds only polling (≈19s of inference)
 * plus follow-up rounds: an empty poll returned `running` after 5s, or the
 * model polled a process that had already exited while it read files. These
 * tests pin the two remedies: empty polls of non-interactive commands wait
 * for exit, and unobserved exits ride on the next tool batch.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  __testing,
  execCommand,
  takeUnreportedExitNotices,
  writeStdin,
} from '@mcp/code-agent/tools/exec-command.js';
import { drainBackgroundNotices } from '@mcp/code-agent/core/background-notices.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { dispatchTools } from '@mcp/code-agent/core/runner/nodes/executing-dispatch.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';

const SLOW_EXIT = `setTimeout(() => { process.stdout.write('suite done\\n'); process.exit(3); }, 1500);`;
const ECHO = `process.stdin.on('data', (c) => process.stdout.write('echo:' + c)); process.stdin.resume();`;
let slowScript: string;
let echoScript: string;

beforeAll(() => {
  slowScript = join(tmpdir(), `exec-slow-${randomUUID()}.js`);
  echoScript = join(tmpdir(), `exec-echo-${randomUUID()}.js`);
  writeFileSync(slowScript, SLOW_EXIT, 'utf8');
  writeFileSync(echoScript, ECHO, 'utf8');
});
afterAll(() => {
  for (const file of [slowScript, echoScript]) { try { unlinkSync(file); } catch { /* ignore */ } }
});
afterEach(async () => { await __testing.disposeAll(); });

const ctx = (sessionId = `owner-${randomUUID()}`): ToolContext =>
  ({ cwd: process.cwd(), projectName: 'exec-completion', sessionId }) as unknown as ToolContext;
const sessionIdOf = (content: string): string => /session_id=(\S+)/.exec(content)![1];
const waitForExit = async (id: string): Promise<void> => {
  await __testing.sessions.get(id)?.exitedPromise;
};

describe('empty polls wait for completion', () => {
  it('returns the exit of a silent command instead of a short running poll', async () => {
    const owner = ctx();
    const started = await execCommand.handler({ cmd: `node ${slowScript}`, yield_time_ms: 0 }, owner);
    expect(started.content).toContain('status=running');
    const t0 = Date.now();
    const polled = await writeStdin.handler({ session_id: sessionIdOf(started.content), yield_time_ms: 200 }, owner);
    expect(polled.content).toContain('status=exited');
    expect(polled.content).toContain('exit=3');
    expect(polled.content).toContain('suite done');
    expect(Date.now() - t0).toBeLessThan(20_000);
  });

  it('keeps short waits for interactive sessions that received input', async () => {
    const owner = ctx();
    const started = await execCommand.handler({ cmd: `node ${echoScript}`, yield_time_ms: 0 }, owner);
    const id = sessionIdOf(started.content);
    await writeStdin.handler({ session_id: id, chars: 'hi\n', yield_time_ms: 300 }, owner);
    const t0 = Date.now();
    const polled = await writeStdin.handler({ session_id: id, yield_time_ms: 300 }, owner);
    expect(polled.content).toContain('status=running');
    expect(Date.now() - t0).toBeLessThan(process.platform === 'win32' ? 15_000 : 5_000);
  });
});

describe('unobserved exits become background notices', () => {
  it('reports a session the model left running exactly once, then answers later polls', async () => {
    const owner = ctx();
    const started = await execCommand.handler({ cmd: `node ${slowScript}`, yield_time_ms: 0 }, owner);
    const id = sessionIdOf(started.content);
    await waitForExit(id);

    const notice = drainBackgroundNotices(owner);
    expect(notice).toContain(`[background exec] session ${id} exited while you worked`);
    expect(notice).toContain('status=exited');
    expect(notice).toContain('exit=3');
    expect(notice).toContain('suite done');
    expect(drainBackgroundNotices(owner)).toBeNull();

    const late = await writeStdin.handler({ session_id: id }, owner);
    expect(late.isError).toBeFalsy();
    expect(late.content).toContain('already reported');
  });

  it('does not report exits the model already observed or sessions of another owner', async () => {
    const owner = ctx();
    const finished = await execCommand.handler({ cmd: 'echo done', yield_time_ms: 5_000 }, owner);
    expect(finished.content).toContain('status=exited');
    const other = await execCommand.handler({ cmd: `node ${slowScript}`, yield_time_ms: 0 }, ctx());
    await waitForExit(sessionIdOf(other.content));
    expect(takeUnreportedExitNotices(`legacy:exec-completion:${process.cwd()}`)).toEqual([]);
    expect(drainBackgroundNotices(owner)).toBeNull();
  });

  it('delivers the notice only to the agent that left the session running', async () => {
    const sessionId = `shared-${randomUUID()}`;
    const parentRunner = { name: 'parent' };
    const subagentRunner = { name: 'subagent' };
    const parent = { ...ctx(sessionId), runner: parentRunner } as unknown as ToolContext;
    const subagent = { ...ctx(sessionId), runner: subagentRunner } as unknown as ToolContext;
    const started = await execCommand.handler({ cmd: `node ${slowScript}`, yield_time_ms: 0 }, parent);
    await waitForExit(sessionIdOf(started.content));
    expect(drainBackgroundNotices(subagent)).toBeNull();
    expect(drainBackgroundNotices(parent)).toContain('exit=3');
  });

  it('appends drained notices to the last result of a dispatched batch', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'read_x', description: '', source: 'native', parameters: { type: 'object', properties: {} },
      handler: async () => ({ content: 'file text' }),
    });
    const batch = await dispatchTools({
      toolUses: [{ id: 'a', name: 'read_x', input: {} }, { id: 'b', name: 'read_x', input: { n: 2 } }],
      registry,
      toolContext: ctx(),
      turn: 1,
      dupCalls: new Map(),
      collectBackgroundNotices: () => '[background exec] session 1234abcd exited',
    });
    expect(batch.results[0].content).toBe('file text');
    expect(batch.results[1].content).toBe('file text\n\n[background exec] session 1234abcd exited');
  });
});
