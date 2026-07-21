/**
 * Integration tests for exec_command + write_stdin.
 *
 * These spawn real processes (no mocks) — that's the entire point.
 * They use a small node script written to tmpdir() as the workload
 * because we can't rely on `cat` (missing on Windows) or `node -e "..."`
 * inline (shell quoting differs across cmd.exe / sh).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execCommand, writeStdin, listSessions, __testing } from '@mcp/code-agent/tools/exec-command.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';

const cwd = process.cwd();

function makeCtx(): ToolContext {
  return { cwd, projectName: 'exec-command-test' };
}

function extractSessionId(content: string): string {
  const m = /session_id=(\S+)/.exec(content);
  if (!m) throw new Error(`no session_id in output:\n${content}`);
  return m[1];
}

// stdin echo: reads stdin, writes "echo:<input>" to stdout for every chunk.
// Unbuffered so the parent sees output without waiting for a newline batch.
const ECHO_STDIN_SCRIPT = `
process.stdout.write('ready\\n');
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  process.stdout.write('echo:' + chunk);
});
process.stdin.resume();
`;

let scriptPath: string;

beforeAll(() => {
  scriptPath = join(tmpdir(), `exec-test-echo-${randomUUID()}.js`);
  writeFileSync(scriptPath, ECHO_STDIN_SCRIPT, 'utf-8');
});

afterAll(() => {
  try {
    unlinkSync(scriptPath);
  } catch {
    /* ignore */
  }
});

afterEach(() => {
  __testing.disposeAll();
});

describe('exec_command + write_stdin', () => {
  it('rejects empty cmd', async () => {
    const result = await execCommand.handler({ cmd: '' }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('cmd cannot be empty');
  });

  it('runs a one-shot command and reports status=exited', async () => {
    const result = await execCommand.handler(
      { cmd: process.platform === 'win32' ? 'echo hello-world' : 'echo hello-world', yield_time_ms: 5000 },
      makeCtx(),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('hello-world');
    expect(result.content).toContain('status=exited');
    expect(result.content).toMatch(/exit=0/);
    // Exited sessions should be reaped from the registry.
    expect(__testing.sessions.size).toBe(0);
  });

  it('keeps a long-running session alive and returns session_id', async () => {
    const r1 = await execCommand.handler(
      { cmd: `node ${scriptPath}`, yield_time_ms: 1500 },
      makeCtx(),
    );
    expect(r1.isError).toBeFalsy();
    expect(r1.content).toContain('status=running');
    // The script prints `ready\n` on startup — should be captured in the
    // first yield window.
    expect(r1.content).toContain('ready');
    const sid = extractSessionId(r1.content);
    expect(__testing.sessions.has(sid)).toBe(true);
  });

  it('write_stdin delivers bytes to the session and yields new output', async () => {
    const r1 = await execCommand.handler(
      { cmd: `node ${scriptPath}`, yield_time_ms: 1500 },
      makeCtx(),
    );
    const sid = extractSessionId(r1.content);

    const r2 = await writeStdin.handler(
      { session_id: sid, chars: 'hi\n', yield_time_ms: 1500 },
      makeCtx(),
    );
    expect(r2.isError).toBeFalsy();
    expect(r2.content).toContain('echo:hi');
    expect(r2.content).toContain('status=running');

    // Second write — confirm the same session keeps working.
    const r3 = await writeStdin.handler(
      { session_id: sid, chars: 'world\n', yield_time_ms: 1500 },
      makeCtx(),
    );
    expect(r3.isError).toBeFalsy();
    expect(r3.content).toContain('echo:world');
  });

  it('empty-chars write_stdin acts as a non-destructive poll', async () => {
    const r1 = await execCommand.handler(
      { cmd: `node ${scriptPath}`, yield_time_ms: 1500 },
      makeCtx(),
    );
    const sid = extractSessionId(r1.content);

    const poll = await writeStdin.handler(
      { session_id: sid, chars: '', yield_time_ms: 300 },
      makeCtx(),
    );
    expect(poll.isError).toBeFalsy();
    expect(poll.content).toContain('status=running');
    // No bytes written → no new output expected from the echo script.
    expect(poll.content).not.toContain('echo:');
  });

  it('returns an error for unknown session_id', async () => {
    const result = await writeStdin.handler(
      { session_id: 'doesnotexist', chars: '' },
      makeCtx(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not active');
  });

  it('redirects to write_file when session_id is a tool name + chars look like a file', async () => {
    // Repro of the real loop: model meant `write_file`, fired write_stdin with
    // session_id="write_file" and a file body in chars.
    const result = await writeStdin.handler(
      { session_id: 'write_file', chars: 'export const x = 1\nexport const y = 2\n' },
      makeCtx(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('MISFIRE');
    expect(result.content).toContain('WRITE A FILE');
    expect(result.content).toContain('write_file');
    // The redirect leads the error so it survives the failure-streak excerpt.
    expect(result.content.indexOf('MISFIRE')).toBeLessThan(result.content.indexOf('not active'));
  });

  it('flags a non-hex session_id as a misfire even without file-ish chars', async () => {
    const result = await writeStdin.handler(
      { session_id: 'some_tool', chars: '' },
      makeCtx(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('MISFIRE');
    expect(result.content).toContain('expand_toolset');
  });

  it('does NOT flag a genuine (hex-shaped) but expired session_id as a misfire', async () => {
    const result = await writeStdin.handler(
      { session_id: 'a1b2c3d4', chars: '' },
      makeCtx(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not active');
    expect(result.content).not.toContain('MISFIRE');
  });

  it('PR 5: write_stdin error lists active sessions for self-correction', async () => {
    // Spawn one long-running session so the error has something to list.
    const r1 = await execCommand.handler(
      { cmd: `node ${scriptPath}`, yield_time_ms: 1500 },
      makeCtx(),
    );
    const sid = extractSessionId(r1.content);

    const bad = await writeStdin.handler(
      { session_id: 'bogus_id', chars: 'x' },
      makeCtx(),
    );
    expect(bad.isError).toBe(true);
    // Lists active session ids so the model can correct itself.
    expect(bad.content).toContain('Active sessions right now');
    expect(bad.content).toContain(sid);
    expect(bad.content).toContain('list_sessions');
    expect(bad.content).toContain('exec_command');
  });

  it('PR 5: write_stdin error explains "no active sessions" when registry is empty', async () => {
    const bad = await writeStdin.handler(
      { session_id: 'nothing_alive', chars: '' },
      makeCtx(),
    );
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain('no active sessions');
  });

  it('PR 5 list_sessions: returns "no active sessions" when empty', async () => {
    const r = await listSessions.handler({}, makeCtx());
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('no active sessions');
  });

  it('PR 5 list_sessions: lists active sessions with id, status, mode and age', async () => {
    const r1 = await execCommand.handler(
      { cmd: `node ${scriptPath}`, yield_time_ms: 1500 },
      makeCtx(),
    );
    const sid = extractSessionId(r1.content);

    const list = await listSessions.handler({}, makeCtx());
    expect(list.isError).toBeFalsy();
    expect(list.content).toContain('Active sessions');
    expect(list.content).toContain(sid);
    expect(list.content).toContain('running');
    // Schema legend present so the model can self-parse the columns.
    expect(list.content).toContain('| <status> |');
  });

  it('caps output while preserving its beginning, true tail and exact omission count', async () => {
    const put = vi.fn(() => 'must-not-be-used');
    const storeCtx = {
      ...makeCtx(),
      toolOutputStore: { put },
    } as unknown as ToolContext;
    const r1 = await execCommand.handler(
      { cmd: `node ${scriptPath}`, yield_time_ms: 5000, max_output_tokens: 1000 },
      storeCtx,
    );
    const sid = extractSessionId(r1.content);
    // The script emits a 6-char `ready\n` banner at startup. Whether it drains
    // inside r1's yield window is a wall-clock race with node's spawn, and on a
    // loaded machine it loses — the banner then sits in `pending` and r2 drains
    // it AHEAD of the echo, shifting every count below by exactly 6. Derive the
    // expected input from what r1 actually observed instead of racing it.
    const bannerPending = r1.content.includes('ready') ? '' : 'ready\n';
    const big =
      `HEAD-${'🙂'.repeat(400)}` +
      `MIDDLE-SENTINEL${'B'.repeat(1_500)}` +
      '-TRUE-TAIL\n';
    const r2 = await writeStdin.handler(
      { session_id: sid, chars: big, yield_time_ms: 1500 },
      storeCtx,
    );
    expect(r2.isError).toBeFalsy();
    expect(r2.content).toContain('output_truncated=true');
    expect(r2.content).toContain('echo:HEAD-');
    expect(r2.content).toContain('-TRUE-TAIL');
    expect(r2.content).not.toContain('MIDDLE-SENTINEL');
    expect(r2.content).not.toContain('�');

    const headerEnd = r2.content.indexOf('\n\n');
    const body = r2.content.slice(headerEnd + 2);
    const marker = body.match(
      /\n\[truncated: (\d+) chars omitted; preserved beginning and true tail\]\n/,
    );
    expect(marker).not.toBeNull();
    const omitted = Number(marker![1]);
    const retained = body.replace(marker![0], '');
    const totalPending = `${bannerPending}echo:${big}`.length;
    expect(omitted).toBe(totalPending - retained.length);
    expect(r2.content).toContain(`output_omitted_chars=${omitted}`);
    expect(body.length).toBeLessThanOrEqual(1_000);
    expect(r2.sourceTruncations).toEqual([
      expect.objectContaining({
        technique: 'bounded-stream-cap',
        unit: 'chars',
        recoverable: false,
        outputSize: body.length,
      }),
    ]);
    expect(r2.sourceTruncations![0]!.inputSize).toBe(totalPending);
    expect(r2.sourceTruncations![0]!.outputId).toBeUndefined();
    expect(put).not.toHaveBeenCalled();
  });
});
