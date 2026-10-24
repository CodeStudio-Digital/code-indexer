import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { BundleToolOutputStore, FsSessionStore } from '../../sessions/fs-store/index.js';
import { attachmentsToBlocks, type AgentMessage } from '../messages.js';
import { projectVisionContext } from '../vision-context.js';
import { toolExtraUserMessages } from '../tool-extra-user-messages.js';
import { viewImage } from '../../tools/view-image.js';
import { viewVideo } from '../../tools/view-video.js';
import type { ToolContext } from '../tool.js';

const roots: string[] = [];
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 3 });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'vision-context-')); roots.push(root);
  const projectRoot = join(root, 'project'); await mkdir(projectRoot);
  const options = { dataDir: join(root, 'data'), projectRootResolver: {
    resolveProjectRoot: () => projectRoot,
    listProjectRoots: () => [{ project_id: 7, root_path: projectRoot }],
  }, projectInfoResolver: () => ({ project_id: 7, name: 'Project', root_path: projectRoot }) };
  const store = FsSessionStore.fromRoots(options);
  const session = await store.createSession({ project_id: 7, title: 'vision', provider: 'test', model: 'test' });
  const media = new BundleToolOutputStore(store, session.id);
  const abort = new AbortController();
  cleanup.push(async () => { abort.abort(); await media.drain(); await store.close(); });
  const ctx = { cwd: projectRoot, projectName: 'Project', toolOutputStore: media, signal: abort.signal } as ToolContext;
  const png = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#d12345' } }).png().toBuffer();
  return { root, projectRoot, options, store, session, media, ctx, png };
}

it('sends references for 15 attachments, selected pixels once, and reopens originals after restart/compaction', async () => {
  const f = await fixture();
  const attachments = Array.from({ length: 15 }, (_, i) => ({ name: `design-${i}.png`, mediaType: 'image/png', base64: f.png.toString('base64') }));
  const history: AgentMessage[] = [{ role: 'user', content: attachmentsToBlocks('Compare these', attachments) }];
  const projected = projectVisionContext(history, f.media);
  expect(projected[0]!.content.filter(b => b.type === 'image')).toHaveLength(0);
  expect(history[0]!.content.filter(b => b.type === 'image')).toHaveLength(15);
  const id = f.media.listImages()[0]!.id;
  const viewed = await viewImage.handler({ attachment_id: id, crop: { left: 0, top: 0, width: 60, height: 40 } }, f.ctx);
  expect(viewed.isError).toBeFalsy();
  const toolMessages = toolExtraUserMessages([{ name: 'view_image', ...viewed }]);
  history.push({ role: 'assistant', content: [{ type: 'text', text: 'Inspecting image' }] }, ...toolMessages);
  expect(projectVisionContext(history, f.media).flatMap(m => m.content).filter(b => b.type === 'image')).toHaveLength(1);
  history.push({ role: 'assistant', content: [{ type: 'text', text: 'I saw the crop.' }] });
  expect(projectVisionContext(history, f.media).flatMap(m => m.content).filter(b => b.type === 'image')).toHaveLength(0);
  await f.media.drain(); await f.store.close();
  const reopened = FsSessionStore.fromRoots(f.options); await reopened.refresh();
  const recovered = new BundleToolOutputStore(reopened, f.session.id);
  const ctx = { ...f.ctx, toolOutputStore: recovered };
  expect(JSON.parse((await viewImage.handler({ action: 'list' }, ctx)).content).images[0].id).toBe(id);
  const original = await viewImage.handler({ attachment_id: id }, ctx);
  expect(original.content).toContain('original 120×80');
  expect(original.extraUserBlocks?.[0]?.type).toBe('image');
  await recovered.drain(); await reopened.close();
});

it('opens an un-attached project image and rejects outside paths, invalid crops and unknown session IDs', async () => {
  const f = await fixture();
  await writeFile(join(f.projectRoot, 'asset.png'), f.png);
  await writeFile(join(f.root, 'outside.png'), f.png);
  const result = await viewImage.handler({ path: 'asset.png', max_dimension: 64 }, f.ctx);
  expect(result.isError).toBeFalsy(); expect(result.content).toContain('preview 64×43');
  expect((await viewImage.handler({ path: '../outside.png' }, f.ctx)).isError).toBe(true);
  expect((await viewImage.handler({ path: 'asset.png', crop: { left: 100, top: 0, width: 100, height: 10 } }, f.ctx)).isError).toBe(true);
  expect((await viewImage.handler({ attachment_id: 'abcdef123456' }, f.ctx)).isError).toBe(true);
  await f.media.drain(); await f.store.close();
});

it('extracts chosen video frames locally, with no external provider request', async () => {
  const f = await fixture();
  const require = createRequire(import.meta.url);
  const ffmpeg = require('ffmpeg-static') as string;
  execFileSync(ffmpeg, ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x48:d=1', '-threads', '1', '-y', join(f.projectRoot, 'clip.mp4')], { windowsHide: true, timeout: 10_000 });
  const result = await viewVideo.handler({ path: 'clip.mp4', timestamps: [0, 0.5] }, f.ctx);
  expect(result.isError).toBeFalsy(); expect(result.extraUserBlocks).toHaveLength(2);
  const history = toolExtraUserMessages([{ name: 'view_video', ...result }]);
  projectVisionContext(history, f.media);
  expect(f.media.listImages().length).toBeGreaterThan(0);
  expect((await viewVideo.handler({ path: 'clip.mp4', timestamps: [99] }, f.ctx)).isError).toBe(true);
  await f.media.drain(); await f.store.close();
}, 75_000); // Three real extractions each have a 20s deadline, plus fixture creation.
