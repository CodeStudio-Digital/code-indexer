import { expect, it, vi } from 'vitest';
import { ProcessOutput, readProcessOutput } from '../process-output.js';

it('paginates a fixed Unicode snapshot without duplication and denies another owner', async () => {
  const output = new ProcessOutput('owner-a');
  const source = 'á🙂漢字'.repeat(40);
  output.append(source);
  const first = await readProcessOutput('owner-a', output.id, undefined, 17);
  output.append('LATER');
  let text = first.text, cursor = first.nextCursor;
  while (cursor) {
    const page = await readProcessOutput('owner-a', output.id, cursor, 17);
    text += page.text; cursor = page.nextCursor;
  }
  expect(text).toBe(source);
  expect(() => readProcessOutput('owner-b', output.id)).toThrow(/not found/);
  await expect(readProcessOutput('owner-a', output.id, first.nextCursor! + 'invalid')).rejects.toThrow(/cursor/);
  expect((await readProcessOutput('owner-a', output.id)).text).toBe(source + 'LATER');
  output.finish();
});

it('declares source loss after the spool budget instead of claiming recoverability', async () => {
  const output = new ProcessOutput('quota');
  for (let index = 0; index < 129; index++) {
    output.append('x'.repeat(65536));
    await output.page();
  }
  output.finish();
  expect(output.evidence()).toMatchObject({ retainedBytes: 8 * 1024 * 1024, observedBytes: 129 * 65536, complete: false });
});

it('recovers finished output and the same cursor after a host module restart', async () => {
  const output = new ProcessOutput('recovery-owner');
  output.append('a🙂b漢字'.repeat(30));
  output.finish();
  const first = await output.page(undefined, 18);
  vi.resetModules();
  const restarted = await import('../process-output.js');
  const next = await restarted.readProcessOutput('recovery-owner', output.id, first.nextCursor!, 18);
  expect(next.offset).toBe(first.end);
  expect(next.executionState).toBe('finished');
  expect(next.complete).toBe(true);
  expect(() => restarted.readProcessOutput('other-owner', output.id)).toThrow(/not found/);
});
