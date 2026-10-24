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
