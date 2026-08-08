import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ControlPlaneFileRepository } from '../control-plane-file-repository.js';
import {
  SpriteSessionRepository,
  normalizeSpriteProductReference,
} from '../sprite-session-repository.js';

let temporaryRoot: string;
let sessionRoot: string;

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'mcp-operational-files-'));
  sessionRoot = join(temporaryRoot, randomUUID());
  await mkdir(sessionRoot);
});

afterEach(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe('ControlPlaneFileRepository', () => {
  it('stores command/run/attempt relations as UUIDs and journals runtime events', async () => {
    const repository = new ControlPlaneFileRepository({ sessionRoot });
    const command = await repository.createCommand({
      data: {
        commandType: 'turn',
        status: 'accepted',
        inputHash: 'a'.repeat(64),
      },
    });
    const run = await repository.createRun({
      relations: { command: command.id },
      data: { status: 'running' },
    });
    const attempt = await repository.createAttempt({
      relations: { command: command.id, run: run.id },
      data: { ordinal: 1, status: 'running' },
    });
    const event = await repository.appendEvent({
      relations: { command: command.id, run: run.id, attempt: attempt.id },
      data: {
        eventType: 'provider.started',
        payload: { provider: 'test' },
      },
    });
    const checkpoint = await repository.createCheckpoint({
      relations: { run: run.id },
      data: { checkpointType: 'resolved_capability_set' },
    });

    await Promise.all([
      stat(join(sessionRoot, 'events', 'commands', `${command.id}.json`)),
      stat(join(sessionRoot, 'events', 'runs', `${run.id}.json`)),
      stat(join(sessionRoot, 'events', 'attempts', `${attempt.id}.json`)),
      stat(join(sessionRoot, 'events', 'runtime', `${event.id}.json`)),
      stat(join(
        sessionRoot,
        'checkpoints',
        'control-plane',
        `${checkpoint.id}.json`,
      )),
    ]);
    const eventsForRun = await repository.listByRelation(
      'event',
      'run',
      run.id,
    );
    expect(eventsForRun.items.map((item) => item.id)).toEqual([event.id]);
    await expect(
      repository.update('event', event.id, {
        data: { eventType: 'mutated' },
      }),
    ).rejects.toThrow('immutable');

    const journal = await readFile(
      join(sessionRoot, 'events', 'runtime', '.journal.jsonl'),
      'utf8',
    );
    expect(journal.trim().split('\n')).toHaveLength(1);
  });
});

describe('SpriteSessionRepository', () => {
  it('uses sprite/project.json and one file per asset/version/job/animation/frame', async () => {
    const repository = new SpriteSessionRepository({ sessionRoot });
    const project = await repository.createProject({
      data: { name: 'Hero pack', status: 'active' },
    });
    const asset = await repository.createAsset({
      relations: { project: project.id },
      data: { name: 'Hero', status: 'ready' },
    });
    const version = await repository.createVersion({
      relations: { project: project.id, asset: asset.id },
      data: {
        version: 1,
        product: {
          path: 'art\\hero-v1.png',
          sha256: 'A'.repeat(64),
          mediaType: 'image/png',
        },
      },
    });
    const job = await repository.createJob({
      relations: { project: project.id, asset: asset.id },
      data: { jobType: 'generate', status: 'complete' },
    });
    const animation = await repository.createAnimation({
      relations: { project: project.id, asset: asset.id },
      data: { name: 'idle', status: 'ready' },
    });
    const frame = await repository.createFrame({
      relations: {
        project: project.id,
        asset: asset.id,
        animation: animation.id,
      },
      data: {
        frameIndex: 0,
        product: {
          path: 'art/idle/frame-000.png',
          sha256: 'b'.repeat(64),
        },
      },
    });

    await Promise.all([
      stat(join(sessionRoot, 'sprite', 'project.json')),
      stat(join(sessionRoot, 'sprite', 'assets', `${asset.id}.json`)),
      stat(join(sessionRoot, 'sprite', 'versions', `${version.id}.json`)),
      stat(join(sessionRoot, 'sprite', 'jobs', `${job.id}.json`)),
      stat(
        join(
          sessionRoot,
          'sprite',
          'animations',
          `${animation.id}.json`,
        ),
      ),
      stat(join(sessionRoot, 'sprite', 'frames', `${frame.id}.json`)),
    ]);
    expect(version.data.product.path).toBe('art/hero-v1.png');
    expect(version.data.product.sha256).toBe('a'.repeat(64));

    const projectBody = JSON.parse(
      await readFile(join(sessionRoot, 'sprite', 'project.json'), 'utf8'),
    ) as { id: string };
    expect(projectBody.id).toBe(project.id);
  });

  it('rejects absolute/traversing paths and invalid hashes before persistence', async () => {
    expect(() =>
      normalizeSpriteProductReference({
        path: '../outside.png',
        sha256: 'a'.repeat(64),
      }),
    ).toThrow('unsafe segment');
    expect(() =>
      normalizeSpriteProductReference({
        path: 'C:\\outside.png',
        sha256: 'a'.repeat(64),
      }),
    ).toThrow('project-relative');
    expect(() =>
      normalizeSpriteProductReference({
        path: 'art/hero.png',
        sha256: 'not-a-hash',
      }),
    ).toThrow('64 hex');

    const repository = new SpriteSessionRepository({ sessionRoot });
    await expect(
      repository.createVersion({
        data: {
          version: 1,
          product: {
            path: '../outside.png',
            sha256: 'a'.repeat(64),
          },
        },
      }),
    ).rejects.toThrow('unsafe segment');
  });

  it('keeps versions and frames immutable', async () => {
    const repository = new SpriteSessionRepository({ sessionRoot });
    const version = await repository.createVersion({
      data: {
        version: 1,
        product: {
          path: 'art/hero.png',
          sha256: 'a'.repeat(64),
        },
      },
    });
    await expect(
      repository.update('version', version.id, {
        data: {
          version: 2,
          product: {
            path: 'art/hero-v2.png',
            sha256: 'b'.repeat(64),
          },
        },
      }),
    ).rejects.toThrow('immutable');
  });
});
