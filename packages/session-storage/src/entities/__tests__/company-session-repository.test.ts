import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CompanySessionRepository,
  type EncryptedCompanySecret,
  type SecretCipher,
} from '../company-session-repository.js';

let temporaryRoot: string;
let sessionRoot: string;

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'mcp-company-files-'));
  sessionRoot = join(temporaryRoot, randomUUID());
  await mkdir(sessionRoot);
});

afterEach(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe('CompanySessionRepository', () => {
  it('keeps board, inbox, agent and App Studio records in independent files', async () => {
    const repository = new CompanySessionRepository({ sessionRoot });
    const agentId = randomUUID();
    const board = await repository.createBoardItem({
      relations: { agent: agentId },
      data: {
        author_role: 'master',
        agent_run_id: agentId,
        kind: 'decision',
        content: 'Ship filesystem sessions',
        mentions: ['frontend'],
        archive_id: null,
      },
    });
    const inbox = await repository.createInboxMessage({
      relations: { agent: agentId },
      data: {
        from_agent_run_id: agentId,
        from_role: 'master',
        to_role: 'frontend',
        to_agent_run_id: null,
        kind: 'question',
        body: 'Please review the migration',
        status: 'pending',
        answer: null,
        wait_token: null,
        delivered_at: null,
        answered_at: null,
        thread_id: randomUUID(),
        reply_to_message_id: null,
        priority: 'normal',
        context_json: null,
      },
    });
    const run = await repository.createAgentRun({
      relations: { agent: agentId },
      data: { status: 'running' },
    });
    const workflow = await repository.createAppStudioWorkflow({
      relations: { agentRun: run.id },
      data: { name: 'Build app', status: 'running' },
    });

    await Promise.all([
      stat(join(sessionRoot, 'company', 'board-items', `${board.id}.json`)),
      stat(
        join(
          sessionRoot,
          'company',
          'inbox-messages',
          `${inbox.id}.json`,
        ),
      ),
      stat(join(sessionRoot, 'company', 'agent-runs', `${run.id}.json`)),
      stat(
        join(
          sessionRoot,
          'company',
          'app-studio-workflows',
          `${workflow.id}.json`,
        ),
      ),
    ]);
    const byAgent = await repository.listByRelation(
      'boardItem',
      'agent',
      agentId,
    );
    expect(byAgent.items.map((item) => item.id)).toEqual([board.id]);
  });

  it('fails closed before IO when plaintext secrets cannot be encrypted', async () => {
    const repository = new CompanySessionRepository({ sessionRoot });
    await expect(
      repository.createEnvironment({
        data: {
          name: 'production',
          secrets: { API_TOKEN: 'plain-secret' },
        },
      }),
    ).rejects.toThrow('SecretCipher is unavailable');
    await expect(
      readdir(join(sessionRoot, 'company', 'environments')),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    await expect(
      repository.create('service', {
        data: {
          name: 'api',
          status: 'up',
          token: 'also-plaintext',
        },
      }),
    ).rejects.toThrow('plaintext Company secret');
  });

  it('persists only encrypted secret envelopes and never journals plaintext', async () => {
    const plaintext = 'highly-sensitive-value';
    const cipher: SecretCipher = {
      encrypt: vi.fn(
        async (_value, context): Promise<EncryptedCompanySecret> => ({
          kind: 'encrypted-company-secret',
          version: 1,
          algorithm: 'test-keychain-aead',
          keyId: `test:${context.entityId}`,
          nonce: 'nonce',
          ciphertext: Buffer.from(`sealed:${_value}`).toString('base64'),
        }),
      ),
    };
    const repository = new CompanySessionRepository({
      sessionRoot,
      secretCipher: cipher,
    });
    const environment = await repository.createEnvironment({
      data: {
        name: 'production',
        variables: { REGION: 'sa-east-1' },
        secrets: { API_TOKEN: plaintext },
      },
    });
    expect(environment.data.secrets?.API_TOKEN.kind).toBe(
      'encrypted-company-secret',
    );
    expect(environment.data.secrets?.API_TOKEN.ciphertext).not.toBe(plaintext);

    const entityDirectory = join(
      sessionRoot,
      'company',
      'environments',
    );
    const persisted = await Promise.all(
      (await readdir(entityDirectory)).map((name) =>
        readFile(join(entityDirectory, name), 'utf8'),
      ),
    );
    expect(persisted.join('\n')).not.toContain(plaintext);
    expect(cipher.encrypt).toHaveBeenCalledTimes(1);

    const updated = await repository.updateEnvironment(environment.id, {
      data: {
        name: 'production-renamed',
        variables: { REGION: 'us-east-1' },
      },
    });
    expect(updated.data.secrets).toEqual(environment.data.secrets);
  });

  it('does not write an entity when the cipher fails', async () => {
    const repository = new CompanySessionRepository({
      sessionRoot,
      secretCipher: {
        encrypt: async () => {
          throw new Error('keychain locked');
        },
      },
    });
    await expect(
      repository.createEnvironment({
        data: {
          name: 'production',
          secrets: { PASSWORD: { plaintext: 'secret' } },
        },
      }),
    ).rejects.toThrow('no data was persisted');
    await expect(
      readdir(join(sessionRoot, 'company', 'environments')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps log records immutable', async () => {
    const repository = new CompanySessionRepository({ sessionRoot });
    const log = await repository.create('log', {
      data: { level: 'info', message: 'started' },
    });
    await expect(
      repository.update('log', log.id, {
        data: { level: 'info', message: 'changed' },
      }),
    ).rejects.toThrow('immutable');
  });
});
