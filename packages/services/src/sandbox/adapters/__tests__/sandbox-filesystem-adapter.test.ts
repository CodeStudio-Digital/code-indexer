import { expect, it, vi } from 'vitest';
import { SandboxFilesystemAdapter } from '../sandbox-filesystem-adapter.js';
import type { ISandboxDriver } from '../../ports/sandbox-driver.js';

it('uses discrete argv and stdin for exclusive creation without falling back to overwrite', async () => {
  const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }), writeFile = vi.fn();
  const port = new SandboxFilesystemAdapter({ containerId: 'isolated', driver: { run, writeFile } as unknown as ISandboxDriver });
  const name = '/app/spaces/$(not-a-command) "quoted".txt', content = 'literal\n`text` $()';
  await port.createFile(name, content);
  const [id, program, argv, options] = run.mock.calls[0];
  expect(id).toBe('isolated'); expect(program).toBe('sh');
  expect(argv.slice(2)).toEqual(['sh', name, '/app/spaces']);
  expect(argv[1]).not.toContain(name); expect(options.stdin).toBe(content);
  expect(writeFile).not.toHaveBeenCalled();
  run.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'destination exists' });
  await expect(port.createFile(name, 'replacement')).rejects.toThrow('exclusive creation failed');
  expect(writeFile).not.toHaveBeenCalled();
});

it('bounds sandbox reads at dispatch and refuses oversized or cancelled output', async () => {
  const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'abcde', stderr: '' });
  const port = new SandboxFilesystemAdapter({ containerId: 'isolated', driver: { run } as unknown as ISandboxDriver });
  await expect(port.readFileBounded('/app/file', 4)).rejects.toThrow('exceeds');
  expect(run.mock.calls[0][2].slice(2)).toEqual(['sh', '/app/file', '5']);
  expect(run.mock.calls[0][3].maxOutputBytes).toBe(15);
  run.mockClear();
  await expect(port.readFileBounded('/app/file', 4, AbortSignal.abort(new Error('cancel')))).rejects.toThrow('cancel');
  expect(run).not.toHaveBeenCalled();
});
