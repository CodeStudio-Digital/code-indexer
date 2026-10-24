import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { asAgentRunId } from '@mcp/agent-runtime-contracts';
import { nativeChildSessionRoot, resolveNativeChildSessionRoot } from '../native-child-storage.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'native-child-storage-')); roots.push(directory);
  const root = join(directory, 'sessions'), outside = join(directory, 'outside');
  await mkdir(root); await mkdir(outside);
  return { root, outside, context: { agentRunId: asAgentRunId(randomUUID()) } };
}
it('creates and reopens only the exact child namespace', async () => {
  const f = await fixture();
  expect(await resolveNativeChildSessionRoot(f.root, f.context, true)).toBe(nativeChildSessionRoot(f.root, f.context));
  expect(await resolveNativeChildSessionRoot(f.root, f.context)).toBe(join(f.root, 'children', f.context.agentRunId));
  await expect(resolveNativeChildSessionRoot(f.root, { agentRunId: asAgentRunId(randomUUID()) })).rejects.toMatchObject({ code: 'ENOENT' });
  expect(() => nativeChildSessionRoot(f.root, { agentRunId: '../outside' as never })).toThrow('Invalid');
});
it.each(['children', 'child'])('rejects a %s junction before creating anything beyond it', async level => {
  const f = await fixture();
  if (level === 'child') await mkdir(join(f.root, 'children'));
  const path = level === 'children' ? join(f.root, 'children') : nativeChildSessionRoot(f.root, f.context);
  await symlink(f.outside, path, process.platform === 'win32' ? 'junction' : 'dir');
  await expect(resolveNativeChildSessionRoot(f.root, f.context, true)).rejects.toThrow(/Unsafe|escaped/);
  await expect(access(join(f.outside, f.context.agentRunId))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(resolveNativeChildSessionRoot(f.root, f.context)).rejects.toThrow(/Unsafe|escaped/);
});
