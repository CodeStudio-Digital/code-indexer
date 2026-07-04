/**
 * Animation slice tests: action catalog invariants, frame-pack intent
 * content, the runner's explicit-grid override and promote-frames (all
 * candidates → versions + frame rows) over the shared runner fakes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_SPRITE_STYLE } from '@mcp/store/sprite-studio/types.js';
import type { SpriteFrameRow } from '@mcp/store/sprite-studio/types.js';
import { actionSpec, SPRITE_ACTION_CATALOG } from '../action-catalog.js';
import { buildAnimationIntent } from '../animation-prompt.js';
import { runGenerationJob } from '../job-runner.js';
import { promoteFrames, stagedCandidateIndices } from '../promote-frames.js';
import { writeAssetManifest } from '../../repo/manifest.js';
import { fakeClient, makeWorld, RED_1PX } from './runner-fakes.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sprite-anim-test-'));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

describe('action catalog', () => {
  it('covers the standard actions with frame-pack-friendly defaults', () => {
    const names = SPRITE_ACTION_CATALOG.map((a) => a.action);
    expect(names).toEqual(['idle', 'walk', 'run', 'attack', 'hit', 'death', 'jump', 'cast']);
    for (const spec of SPRITE_ACTION_CATALOG) {
      expect(spec.frames).toBeGreaterThanOrEqual(2);
      expect(spec.frames).toBeLessThanOrEqual(8); // one grid ROW must stay readable
      expect(spec.fps).toBeGreaterThan(0);
      expect(spec.phrase.length).toBeGreaterThan(0);
    }
    expect(actionSpec('walk')).toMatchObject({ frames: 6, fps: 8, loopMode: 'loop' });
    expect(actionSpec('  WALK ')).toBeDefined(); // trim + case-insensitive
    expect(actionSpec('custom:spin')).toBeUndefined();
  });
});

describe('buildAnimationIntent', () => {
  it('describes a single row of n frames of the same character', () => {
    const intent = buildAnimationIntent('walk', 6);
    expect(intent).toContain('a single row of 6 animation frames');
    expect(intent).toContain('SAME character');
    expect(intent).toContain('walk cycle');
    expect(intent).toContain('frame-by-frame progression');
    // Must override the packed-variants suffix's "distinct variations" language.
    expect(intent).toContain('not an alternative design');
  });

  it('honors direction codes and humanizes custom actions', () => {
    expect(buildAnimationIntent('walk', 6, 'W')).toContain('facing left');
    expect(buildAnimationIntent('walk', 4, 'side')).toContain('side view');
    expect(buildAnimationIntent('custom:spin_fast', 4)).toContain('spin fast');
    expect(buildAnimationIntent('walk', 6)).not.toContain('facing');
  });
});

describe('runGenerationJob — explicit grid (animation frame-pack)', () => {
  it('passes the n×1 grid to the prompt suffix and the slicer', async () => {
    const client = fakeClient();
    let seenPrompt = '';
    client.generate = async (req) => {
      seenPrompt = req.prompt;
      return { images: [{ base64: RED_1PX.toString('base64'), mediaType: 'image/png' }] };
    };
    const link = { providerId: 'openai', modelId: 'gpt-image-1' };
    const w = makeWorld({ scratchRoot: path.join(tmpRoot, 'grid'), chain: [{ link, client }] });
    let sliceArgs: [number, number] | null = null;
    w.deps.sliceImage = async (_png, cols, rows) => {
      sliceArgs = [cols, rows];
      return Array.from({ length: 6 }, () => RED_1PX);
    };
    await runGenerationJob(w.deps, w.jobRow, {
      intent: buildAnimationIntent('walk', 6),
      style: { ...DEFAULT_SPRITE_STYLE },
      n: 6,
      packVariants: true,
      grid: { cols: 6, rows: 1 },
    });
    expect(sliceArgs).toEqual([6, 1]); // NOT gridFor(6) = 3x2
    expect(seenPrompt).toContain('6x1 grid');
    expect(w.events.filter((e) => e.type === 'sprite_variant_ready')).toHaveLength(6);
  });
});

describe('promoteFrames', () => {
  it('promotes every staged candidate in order and replaces the frame rows', async () => {
    const projectRoot = path.join(tmpRoot, 'repo');
    fs.mkdirSync(projectRoot, { recursive: true });
    writeAssetManifest(projectRoot, 'goblin', {
      slug: 'goblin', displayName: 'Goblin', category: 'enemy',
      tags: [], status: 'draft', versions: [],
    });
    const w = makeWorld({
      scratchRoot: path.join(tmpRoot, 'promote'),
      chain: [], projectRoot, assetId: 7, assetSlug: 'goblin',
    });
    const scratch = w.deps.scratchDir(900);
    fs.mkdirSync(scratch, { recursive: true });
    for (const i of [0, 1, 2]) fs.writeFileSync(path.join(scratch, `candidate-${i}.png`), RED_1PX);

    const replaced: Array<{ animationId: number; versionIds: number[] }> = [];
    const animations = {
      replaceFrames: (animationId: number, frames: Array<{ frame_index: number; version_id: number; duration_ms?: number | null }>): SpriteFrameRow[] => {
        replaced.push({ animationId, versionIds: frames.map((f) => f.version_id) });
        return frames.map((f, i) => ({
          id: i + 1, animation_id: animationId, frame_index: i,
          version_id: f.version_id, duration_ms: f.duration_ms ?? null,
        }));
      },
    };
    const result = await promoteFrames(
      {
        stores: { assets: w.deps.stores.assets, jobs: w.deps.stores.jobs, animations },
        scratchDir: w.deps.scratchDir,
        projectRoot: () => projectRoot,
        now: () => '2026-07-03T00:00:00.000Z',
      },
      { jobId: 900, animationId: 42, asset: { id: 7, slug: 'goblin' } },
    );

    expect(result.versions.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(w.insertedVersions).toHaveLength(3);
    expect(replaced).toEqual([{ animationId: 42, versionIds: [101, 102, 103] }]);
    expect(result.frames.map((f) => f.frame_index)).toEqual([0, 1, 2]);
    for (const v of [1, 2, 3]) {
      expect(
        fs.existsSync(path.join(projectRoot, '.sprite-studio', 'assets', 'goblin', `v00${v}.png`)),
      ).toBe(true);
    }
    // The asset had no current version → the FIRST frame becomes it (not the
    // last one promoteCandidate happened to touch).
    expect(w.currentVersionSets.at(-1)).toEqual([7, 101]);
  });

  it('stops candidate discovery at the first index gap and fails on none', async () => {
    const dir = path.join(tmpRoot, 'gaps');
    fs.mkdirSync(dir, { recursive: true });
    for (const i of [0, 1, 3]) fs.writeFileSync(path.join(dir, `candidate-${i}.png`), RED_1PX);
    expect(stagedCandidateIndices(dir)).toEqual([0, 1]);
    expect(stagedCandidateIndices(path.join(tmpRoot, 'missing-dir'))).toEqual([]);

    const w = makeWorld({ scratchRoot: path.join(tmpRoot, 'none'), chain: [] });
    const animations = { replaceFrames: (): SpriteFrameRow[] => [] };
    await expect(
      promoteFrames(
        {
          stores: { assets: w.deps.stores.assets, jobs: w.deps.stores.jobs, animations },
          scratchDir: w.deps.scratchDir,
          projectRoot: () => tmpRoot,
        },
        { jobId: 900, animationId: 1, asset: { id: 7, slug: 'goblin' } },
      ),
    ).rejects.toThrow(/No staged candidates/);
  });
});
