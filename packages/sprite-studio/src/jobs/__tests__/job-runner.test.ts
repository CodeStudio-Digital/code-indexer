import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_SPRITE_STYLE, type SpriteStyleConfig } from '@mcp/store/sprite-studio/types.js';
import { runGenerationJob } from '../job-runner.js';
import { writeAssetManifest } from '../../repo/manifest.js';
import { spriteDir } from '../../repo/paths.js';
import { fakeClient, makeWorld, RED_1PX, spriteId } from './runner-fakes.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sprite-jobs-test-'));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const style: SpriteStyleConfig = { ...DEFAULT_SPRITE_STYLE };
const link = { providerId: 'openai', modelId: 'gpt-image-1' };

describe('runGenerationJob — happy path (staged variants)', () => {
  it('walks the lifecycle, stages candidates and finishes with candidates[]', async () => {
    const w = makeWorld({ scratchRoot: path.join(tmpRoot, 'happy'), chain: [{ link, client: fakeClient() }] });
    await runGenerationJob(w.deps, w.jobRow, { intent: 'a goblin chef', style, n: 2 });

    expect(w.statuses).toEqual(['prompting', 'generating', 'postprocess', 'done']);
    expect(w.jobRow.expanded_prompt).toContain('a goblin chef');
    expect(w.jobRow.expanded_prompt).toContain('pixel art'); // deterministic template used
    expect(w.jobRow.provider_id).toBe('openai');
    expect(w.jobRow.model_id).toBe('gpt-image-1');
    expect(w.results.some((r) => typeof r.cost_usd === 'number' && (r.cost_usd as number) > 0)).toBe(true);

    for (const i of [0, 1]) {
      expect(fs.existsSync(path.join(w.deps.scratchDir(spriteId(900)), `candidate-${i}.png`))).toBe(true);
    }
    const variants = w.events.filter((e) => e.type === 'sprite_variant_ready');
    expect(variants).toHaveLength(2);
    expect(variants[1]).toMatchObject({
      jobId: spriteId(900), index: 1, candidateId: 'candidate-1',
      thumbUrl: `/api/sprite-studio/jobs/${spriteId(900)}/candidates/1/thumb`,
    });
    const done = w.events.find((e) => e.type === 'sprite_job_done');
    expect(done).toMatchObject({ jobId: spriteId(900), candidates: [
      { candidateId: 'candidate-0', index: 0 }, { candidateId: 'candidate-1', index: 1 },
    ]});
    expect(w.insertedVersions).toHaveLength(0); // staged: no version rows
  });

  it('packs n variants into ONE grid generation and slices locally (default for n>1)', async () => {
    const client = fakeClient();
    let seenN = -1;
    let seenPrompt = '';
    client.generate = async (req) => {
      seenN = req.n ?? 1;
      seenPrompt = req.prompt;
      return { images: [{ base64: RED_1PX.toString('base64'), mediaType: 'image/png' }] };
    };
    const w = makeWorld({ scratchRoot: path.join(tmpRoot, 'packed'), chain: [{ link, client }] });
    let sliceArgs: [number, number] | null = null;
    w.deps.sliceImage = async (_png, cols, rows) => {
      sliceArgs = [cols, rows];
      return [RED_1PX, RED_1PX, RED_1PX, RED_1PX];
    };
    await runGenerationJob(w.deps, w.jobRow, { intent: 'slime', style, n: 4 });

    expect(seenN).toBe(1); // ONE image billed, not four
    expect(seenPrompt).toContain('2x2 grid');
    expect(sliceArgs).toEqual([2, 2]);
    expect(w.events.filter((e) => e.type === 'sprite_variant_ready')).toHaveLength(4);
    for (const i of [0, 1, 2, 3]) {
      expect(fs.existsSync(path.join(w.deps.scratchDir(spriteId(900)), `candidate-${i}.png`))).toBe(true);
    }
  });

  it('packVariants:false forces independent generations (diversity over cost)', async () => {
    const client = fakeClient();
    let seenN = -1;
    client.generate = async (req) => {
      seenN = req.n ?? 1;
      const image = { base64: RED_1PX.toString('base64'), mediaType: 'image/png' };
      return { images: Array.from({ length: req.n ?? 1 }, () => image) };
    };
    const w = makeWorld({ scratchRoot: path.join(tmpRoot, 'unpacked'), chain: [{ link, client }] });
    w.deps.sliceImage = async () => { throw new Error('must not slice'); };
    await runGenerationJob(w.deps, w.jobRow, { intent: 'slime', style, n: 3, packVariants: false });
    expect(seenN).toBe(3);
    expect(w.events.filter((e) => e.type === 'sprite_variant_ready')).toHaveLength(3);
  });

  it('falls back to key-color flow when the model lacks native transparency', async () => {
    const client = fakeClient({ transparentBackground: false });
    const w = makeWorld({ scratchRoot: path.join(tmpRoot, 'keycolor'), chain: [{ link, client }] });
    let sentPrompt = '';
    client.generate = async (req) => {
      sentPrompt = req.prompt;
      expect(req.background).toBeUndefined();
      return { images: [{ base64: RED_1PX.toString('base64'), mediaType: 'image/png' }] };
    };
    await runGenerationJob(w.deps, w.jobRow, { intent: 'slime', style });
    expect(sentPrompt).toContain('plain solid #FF00FF background');
    // Global sweep (reserved-color semantics), then framing before quantize.
    expect(w.capturedOps[0][0]).toMatchObject({ op: 'chromaKeySweep', keyColor: '#FF00FF' });
    const opNames = w.capturedOps[0].map((o: { op: string }) => o.op);
    expect(opNames).toEqual(
      expect.arrayContaining(['chromaKeySweep', 'keepLargestComponent', 'fitToCanvas', 'quantize']),
    );
    expect(opNames.indexOf('fitToCanvas')).toBeLessThan(opNames.indexOf('quantize'));
  });
});

describe('runGenerationJob — failover and failure', () => {
  const badLink = { providerId: 'openai', modelId: 'gpt-image-1' };
  const goodLink = { providerId: 'google', modelId: 'gemini-2.5-flash-image' };
  const throwing = fakeClient({}, async () => { throw new Error('403 org not verified'); });

  it('tries the next link when one throws and records the winner', async () => {
    const w = makeWorld({
      scratchRoot: path.join(tmpRoot, 'failover'),
      chain: [{ link: badLink, client: throwing }, { link: goodLink, client: fakeClient() }],
    });
    await runGenerationJob(w.deps, w.jobRow, { intent: 'orc', style });
    expect(w.jobRow.model_id).toBe('gemini-2.5-flash-image');
    expect(w.statuses).toContain('done');
    expect(w.events.some((e) => e.type === 'sprite_job_failed')).toBe(false);
  });

  it('fails the job with sprite_job_failed when every link throws', async () => {
    const w = makeWorld({
      scratchRoot: path.join(tmpRoot, 'allfail'),
      chain: [{ link: badLink, client: throwing }, { link: goodLink, client: throwing }],
    });
    await runGenerationJob(w.deps, w.jobRow, { intent: 'orc', style });
    expect(w.errors).toHaveLength(1);
    expect(w.errors[0]).toContain('403 org not verified');
    const failed = w.events.find((e) => e.type === 'sprite_job_failed');
    expect(failed).toMatchObject({ jobId: spriteId(900) });
    expect(w.statuses).not.toContain('done');
  });

  it('skips links that cannot satisfy a mask request', async () => {
    const w = makeWorld({
      scratchRoot: path.join(tmpRoot, 'nocaps'),
      chain: [{ link: badLink, client: fakeClient({ mask: false }) }],
    });
    await runGenerationJob(w.deps, w.jobRow, {
      intent: 'orc', style, mask: { base64: 'aaaa', mediaType: 'image/png' },
    });
    expect(w.errors[0]).toContain('no bound image model supports');
  });
});

describe('runGenerationJob — autoSave (agent path)', () => {
  it('promotes candidate 0 into a repo version and emits versionId', async () => {
    const projectRoot = path.join(tmpRoot, 'repo');
    fs.mkdirSync(projectRoot, { recursive: true });
    writeAssetManifest(projectRoot, 'goblin', {
      slug: 'goblin', displayName: 'Goblin', category: 'enemy',
      tags: [], status: 'draft', versions: [],
    });
    const w = makeWorld({
      scratchRoot: path.join(tmpRoot, 'autosave'),
      chain: [{ link, client: fakeClient() }],
      projectRoot, assetId: spriteId(7), assetSlug: 'goblin',
    });
    await runGenerationJob(w.deps, w.jobRow, { intent: 'goblin', style, autoSave: true });

    expect(w.statuses).toEqual(['prompting', 'generating', 'postprocess', 'saving', 'done']);
    expect(fs.existsSync(path.join(spriteDir(projectRoot), 'assets', 'goblin', 'v001.png'))).toBe(true);
    expect(w.insertedVersions[0]).toMatchObject({
      asset_id: spriteId(7), version: 1, file_rel_path: 'assets/goblin/v001.png',
      source: 'generated', job_id: spriteId(900), width: 1, height: 1,
    });
    expect(typeof w.insertedVersions[0].content_hash).toBe('string');
    expect(w.currentVersionSets).toEqual([[spriteId(7), spriteId(101)]]);
    expect(w.events.find((e) => e.type === 'sprite_job_done')).toMatchObject({
      jobId: spriteId(900),
      versionId: spriteId(101),
    });
  });

  it('fails cleanly when autoSave lacks an asset_id', async () => {
    const w = makeWorld({
      scratchRoot: path.join(tmpRoot, 'autosave-bad'),
      chain: [{ link, client: fakeClient() }],
      projectRoot: path.join(tmpRoot, 'repo2'), assetId: null,
    });
    await runGenerationJob(w.deps, w.jobRow, { intent: 'goblin', style, autoSave: true });
    expect(w.errors[0]).toContain('asset_id');
  });
});

describe('runGenerationJob — cancellation', () => {
  it('marks the job cancelled when the signal is already aborted', async () => {
    const w = makeWorld({ scratchRoot: path.join(tmpRoot, 'cancel'), chain: [{ link, client: fakeClient() }] });
    const ctrl = new AbortController();
    ctrl.abort();
    await runGenerationJob(w.deps, w.jobRow, { intent: 'goblin', style }, ctrl.signal);
    expect(w.statuses).toEqual(['cancelled']);
    expect(w.events).toEqual([{
      type: 'sprite_job',
      jobId: spriteId(900),
      status: 'cancelled',
    }]);
    expect(w.errors).toHaveLength(0);
  });
});
