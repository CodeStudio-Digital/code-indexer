import { describe, expect, it } from 'vitest';
import { handleExec, execStream, isExecAllowed, type ExecChunk } from '../exec.js';

describe('isExecAllowed', () => {
  const allow = ['npx', 'wrangler'];

  it('allows `npx <pkg>` when both are allowlisted', () => {
    expect(isExecAllowed('npx', ['wrangler', 'deploy'], allow)).toBe(true);
  });
  it('denies `npx <pkg>` when the package is not allowlisted', () => {
    expect(isExecAllowed('npx', ['rimraf', '-rf', '.'], allow)).toBe(false);
  });
  it('denies a binary outside the allowlist', () => {
    expect(isExecAllowed('rm', ['-rf', '/'], allow)).toBe(false);
  });
  it('denies when the allowlist is empty/undefined', () => {
    expect(isExecAllowed('node', [], [])).toBe(false);
    expect(isExecAllowed('node', [], undefined)).toBe(false);
  });
  it('matches on basename incl. a .cmd shim', () => {
    expect(isExecAllowed('npx.cmd', ['wrangler'], allow)).toBe(true);
  });
});

describe('handleExec', () => {
  it('preserves UTF-8 characters split across physical writes', async () => {
    const result = await handleExec({ cmd: process.execPath, args: ['-e',
      'const bytes=Buffer.from("ação 🚀");let i=0;const t=setInterval(()=>{process.stdout.write(bytes.subarray(i,i+1));if(++i===bytes.length)clearInterval(t)},5)',
    ] }, process.cwd(), { allow: ['node'] });
    expect(result).toEqual({ stdout: 'ação 🚀', code: 0 });
  });
  it('runs an allowlisted command, capturing stdout + exit code', async () => {
    const r = await handleExec(
      { cmd: process.execPath, args: ['-e', 'process.stdout.write("hi")'] },
      process.cwd(),
      { allow: ['node'] },
    );
    expect(r.stdout).toContain('hi');
    expect(r.code).toBe(0);
  });

  it('rejects a non-allowlisted command before spawning', async () => {
    await expect(
      handleExec({ cmd: 'rm', args: ['-rf', '/'] }, process.cwd(), { allow: ['node'] }),
    ).rejects.toThrow(/permission_denied/);
  });
});

describe('execStream', () => {
  it('preserves large output with a slow consumer and split UTF-8 characters', async () => {
    const expected = 'ação 🚀\n'.repeat(300_000);
    const chunks: string[] = [];
    let exit: number | null | undefined;
    for await (const frame of execStream({
      cmd: process.execPath,
      args: ['-e', 'const b=Buffer.from("ação 🚀\\n".repeat(300000));let i=0;function write(){if(i>=b.length)return;const end=Math.min(i+65537,b.length);const part=b.subarray(i,end);i=end;process.stdout.write(part,write)}write()'],
      cwd: process.cwd(), allow: ['node'],
    })) {
      if (frame.type === 'data') {
        chunks.push(frame.data);
        await new Promise(resolve => setTimeout(resolve, 2));
      } else exit = frame.code;
    }
    expect(chunks.join('')).toBe(expected);
    expect(exit).toBe(0);
  });
  it('streams data frames then an exit frame', async () => {
    const chunks: ExecChunk[] = [];
    for await (const c of execStream({
      cmd: process.execPath,
      args: ['-e', 'process.stdout.write("a");process.stdout.write("b")'],
      cwd: process.cwd(),
      allow: ['node'],
    })) {
      chunks.push(c);
    }
    const data = chunks.filter((c) => c.type === 'data').map((c) => (c as { data: string }).data).join('');
    const exit = chunks.find((c) => c.type === 'exit') as { type: 'exit'; code: number | null };
    expect(data).toContain('a');
    expect(data).toContain('b');
    expect(exit?.code).toBe(0);
  });

  it('throws permission_denied for a non-allowlisted command', async () => {
    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of execStream({ cmd: 'rm', args: ['-rf', '/'], cwd: process.cwd(), allow: ['node'] })) {
        /* unreachable */
      }
    }).rejects.toThrow(/permission_denied/);
  });

  it('stops the child when the consumer aborts', async () => {
    const ac = new AbortController();
    const seen: string[] = [];
    const iter = execStream({
      cmd: process.execPath,
      args: ['-e', 'setInterval(()=>process.stdout.write("x"),10)'],
      cwd: process.cwd(),
      allow: ['node'],
      signal: ac.signal,
    });
    for await (const c of iter) {
      if (c.type === 'data') {
        seen.push(c.data);
        if (seen.length >= 1) ac.abort();
      }
      if (c.type === 'exit') break;
    }
    expect(seen.length).toBeGreaterThanOrEqual(1);
  });
});
