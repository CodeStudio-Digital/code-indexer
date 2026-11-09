/**
 * Route-level idempotency tests for company POST /start and POST /resume.
 *
 * A `ReconnectingSSEClient` retry re-POSTs the body (stable `client_msg_id`).
 * These assert the retry replays the master's metaBus instead of (a) hitting
 * the "Already running" 409 on /start, or (b) sending a duplicate message to
 * the master on /resume.
 *
 * The orchestrator singleton + master-resolve are mocked so the route mounts
 * without spawning real worker threads.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

type Orch = {
  metaBus: unknown;
  sendMessageToMaster: (...args: unknown[]) => Promise<{
    ok: boolean;
    pending?: 'interactive_wait';
  }>;
};
const H = vi.hoisted(() => ({
  orch: null as Orch | null,
  onSpawn: null as null | (() => Orch),
  spawnGate: null as Promise<void> | null,
  spawnError: null as Error | null,
  resolveAndRunMaster: vi.fn(async () => {}),
  ensureCompanyMasterLive: vi.fn(),
  normalizeAttachments: vi.fn(async (attachments: unknown) => attachments),
  persistAttachments: vi.fn(async () => [{ name: 'a.txt', mediaType: 'text/plain', size: 4, sha256: 'a'.repeat(64) }]),
  companyFiles: null as Record<string, (...args: any[]) => any> | null,
}));

vi.mock('../../../../sse/companyOrchestrator.js', () => ({
  getCompanyOrchestrator: () => H.orch,
  hasCompanyOrchestrator: () => !!H.orch,
  deleteCompanyOrchestrator: () => { H.orch = null; },
  evictCompanyOrchestrator: async () => { H.orch = null; },
  getOrSpawnCompanyOrchestrator: async () => {
    if (H.spawnGate) await H.spawnGate;
    if (H.spawnError) throw H.spawnError;
    if (!H.orch && H.onSpawn) H.orch = H.onSpawn();
    return { orchestrator: H.orch, bus: H.orch!.metaBus };
  },
}));
vi.mock('../master-resolve.js', () => ({ resolveAndRunMaster: H.resolveAndRunMaster }));
vi.mock('@mcp/company/services/board-attachments.js', () => ({ persistBoardAttachments: H.persistAttachments }));
vi.mock('../ensure-master-live.js', () => ({
  ensureCompanyMasterLive: H.ensureCompanyMasterLive,
  ensureCompanyMasterLiveLocked: H.ensureCompanyMasterLive,
}));
vi.mock('@mcp/services/services/docs/attachment-extract.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mcp/services/services/docs/attachment-extract.js')>();
  return { ...actual, normalizeAttachmentsForModel: H.normalizeAttachments };
});
vi.mock('@mcp/company/services/CompanySessionFiles.js', () => ({
  CompanySessionFiles: class {
    getSession() { return H.companyFiles!.getSession(); }
    listAgentRunsSync() { return H.companyFiles!.listAgentRunsSync(); }
    updateSessionStatus(status: string) {
      return H.companyFiles!.updateSessionStatus(status);
    }
    updateSessionConfig(configJson: string) {
      return H.companyFiles!.updateSessionConfig(configJson);
    }
    updateAgentRunProvider(...args: unknown[]) {
      return H.companyFiles!.updateAgentRunProvider(...args);
    }
    getPendingMasterPrompt(kind?: 'plan' | 'question') {
      return H.companyFiles!.getPendingMasterPrompt(kind);
    }
    claimMasterPromptDelivery(...args: unknown[]) {
      return H.companyFiles!.claimMasterPromptDelivery(...args);
    }
    releaseMasterPromptDelivery(...args: unknown[]) {
      return H.companyFiles!.releaseMasterPromptDelivery(...args);
    }
    markMasterPromptDeliveryOutcomeUnknown(...args: unknown[]) {
      return H.companyFiles!.markMasterPromptDeliveryOutcomeUnknown(...args);
    }
    completeMasterPromptDelivery(...args: unknown[]) {
      return H.companyFiles!.completeMasterPromptDelivery(...args);
    }
  },
}));

import { mountCompanyStreamRoutes } from '../stream.js';
import { createBus, markEnded, publish, type CoderRunBus } from '../../../../coder-bus.js';
import type { ServerDeps } from '../../../deps.js';

const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const sessionPath = (suffix: string): string =>
  `/api/company/sessions/${SESSION_ID}${suffix}`;
const PROMPT_71 = '00000000-0000-4000-8000-000000000071';
const PROMPT_72 = '00000000-0000-4000-8000-000000000072';
const PROMPT_73 = '00000000-0000-4000-8000-000000000073';
const PROMPT_81 = '00000000-0000-4000-8000-000000000081';
const PROMPT_82 = '00000000-0000-4000-8000-000000000082';
const PROMPT_83 = '00000000-0000-4000-8000-000000000083';

function makeOrch(): Orch {
  return {
    metaBus: createBus(new AbortController()),
    sendMessageToMaster: vi.fn(async () => ({ ok: true })),
  };
}

function portClosedError(): Error & { code: 'port_closed' } {
  return Object.assign(new Error('worker port closed'), { code: 'port_closed' as const });
}

function requestTimeoutError(): Error & { code: 'request_timeout' } {
  return Object.assign(
    new Error('worker request acknowledgement timed out'),
    { code: 'request_timeout' as const },
  );
}

function setup(
  sessionOverrides: Record<string, unknown> = {},
  commands = new Map<string, Record<string, unknown>>(),
  controlPlaneAvailable = true,
) {
  const acceptCalls: unknown[] = [];
  const prompts = new Map<string, {
    id: string;
    company_session_id: string;
    kind: 'plan' | 'question';
    status: 'pending' | 'answered';
    answer: string | null;
    approved: boolean | null;
    feedback: string | null;
    deliveryStatus?: 'pending' | 'delivering' | 'outcome_unknown' | 'delivered';
    deliveryToken?: string | null;
    deliveryPayloadHash?: string | null;
  }>();
  const companyStore = {
      getCompanySession: (id: string) => ({
        id,
        config_json: '{}',
        status: 'idle',
        runtime_kind: 'company',
        ...sessionOverrides,
      }),
      listAgentRuns: () => [],
      setLastUserMessage: () => {},
      updateCompanySessionStatus: () => {},
      getPendingMasterPrompt: (sessionId: string, kind?: 'plan' | 'question') =>
        [...prompts.values()].find((prompt) =>
          prompt.company_session_id === sessionId
          && prompt.status === 'pending'
          && (!kind || prompt.kind === kind),
        ) ?? null,
      getMasterPrompt: (promptId: string) => prompts.get(promptId) ?? null,
      resolveMasterPrompt: (
        promptId: string,
        resolution:
          | { kind: 'plan'; approved: boolean; feedback?: string }
          | { kind: 'question'; answer: string },
      ) => {
        const prompt = prompts.get(promptId);
        if (!prompt || prompt.status !== 'pending' || prompt.kind !== resolution.kind) return null;
        prompt.status = 'answered';
        if (resolution.kind === 'plan') {
          prompt.approved = resolution.approved;
          prompt.feedback = resolution.feedback ?? null;
        } else {
          prompt.answer = resolution.answer;
        }
        return { ...prompt };
      },
      claimMasterPromptDelivery: (
        promptId: string,
        sessionId: string,
        kind: 'plan' | 'question',
        token: string,
        payloadHash: string,
        opts?: { retryOutcomeUnknown?: boolean },
      ) => {
        const prompt = prompts.get(promptId);
        if (
          !prompt
          || prompt.company_session_id !== sessionId
          || prompt.kind !== kind
          || prompt.status !== 'pending'
        ) {
          return { kind: 'not_pending', prompt: prompt ? { ...prompt } : null };
        }
        const deliveryStatus = prompt.deliveryStatus ?? 'pending';
        if (deliveryStatus === 'pending') {
          prompt.deliveryStatus = 'delivering';
          prompt.deliveryToken = token;
          prompt.deliveryPayloadHash = payloadHash;
          return { kind: 'claimed', prompt: { ...prompt }, token };
        }
        if (
          opts?.retryOutcomeUnknown
          && (deliveryStatus === 'delivering' || deliveryStatus === 'outcome_unknown')
        ) {
          if (prompt.deliveryPayloadHash !== payloadHash) {
            return { kind: 'payload_conflict', prompt: { ...prompt } };
          }
          prompt.deliveryStatus = 'delivering';
          prompt.deliveryToken = token;
          return { kind: 'claimed', prompt: { ...prompt }, token };
        }
        return {
          kind: deliveryStatus === 'delivering' ? 'delivery_in_progress' : 'outcome_unknown',
          prompt: { ...prompt },
        };
      },
      releaseMasterPromptDelivery: (promptId: string, token: string) => {
        const prompt = prompts.get(promptId);
        if (
          !prompt
          || prompt.status !== 'pending'
          || prompt.deliveryStatus !== 'delivering'
          || prompt.deliveryToken !== token
        ) {
          return false;
        }
        prompt.deliveryStatus = 'pending';
        prompt.deliveryToken = null;
        prompt.deliveryPayloadHash = null;
        return true;
      },
      markMasterPromptDeliveryOutcomeUnknown: (promptId: string, token: string) => {
        const prompt = prompts.get(promptId);
        if (
          !prompt
          || prompt.status !== 'pending'
          || prompt.deliveryStatus !== 'delivering'
          || prompt.deliveryToken !== token
        ) {
          return false;
        }
        prompt.deliveryStatus = 'outcome_unknown';
        return true;
      },
      completeMasterPromptDelivery: (
        promptId: string,
        token: string,
        resolution:
          | { kind: 'plan'; approved: boolean; feedback?: string }
          | { kind: 'question'; answer: string },
      ) => {
        const prompt = prompts.get(promptId);
        if (
          !prompt
          || prompt.status !== 'pending'
          || prompt.kind !== resolution.kind
          || prompt.deliveryStatus !== 'delivering'
          || prompt.deliveryToken !== token
        ) {
          return null;
        }
        prompt.status = 'answered';
        prompt.deliveryStatus = 'delivered';
        if (resolution.kind === 'plan') {
          prompt.approved = resolution.approved;
          prompt.feedback = resolution.feedback ?? null;
        } else {
          prompt.answer = resolution.answer;
        }
        return { ...prompt };
      },
    };
  H.companyFiles = {
    getSession: () => companyStore.getCompanySession(SESSION_ID),
    listAgentRunsSync: companyStore.listAgentRuns,
    updateSessionStatus: companyStore.updateCompanySessionStatus,
    updateSessionConfig: () => {},
    updateAgentRunProvider: () => {},
    getPendingMasterPrompt: (kind?: 'plan' | 'question') =>
      companyStore.getPendingMasterPrompt(SESSION_ID, kind),
    claimMasterPromptDelivery: (
      promptId: string,
      kind: 'plan' | 'question',
      token: string,
      payloadHash: string,
      opts?: { retryOutcomeUnknown?: boolean },
    ) => companyStore.claimMasterPromptDelivery(
      promptId,
      SESSION_ID,
      kind,
      token,
      payloadHash,
      opts,
    ),
    releaseMasterPromptDelivery: companyStore.releaseMasterPromptDelivery,
    markMasterPromptDeliveryOutcomeUnknown:
      companyStore.markMasterPromptDeliveryOutcomeUnknown,
    completeMasterPromptDelivery: companyStore.completeMasterPromptDelivery,
  };
  const deps = {
    companyStore,
    sessionStore: { ensureCatalog: async () => {} },
    db: {},
    providerStore: { getProvider: () => undefined },
    controlPlaneStore: controlPlaneAvailable ? {
      acceptCommand: (input: {
        command: Record<string, unknown> & {
          commandId: string;
          sessionId: string;
          kind: string;
          idempotencyKey: string;
        };
        payloadHash: string;
      }) => {
        acceptCalls.push(input);
        const key = `${input.command.sessionId}:${input.command.kind}:${input.command.idempotencyKey}`;
        const existing = commands.get(key);
        if (existing) {
          return existing.payloadHash === input.payloadHash
            ? { kind: 'existing', command: existing }
            : { kind: 'payload_conflict', command: existing };
        }
        const command = {
          ...input.command,
          status: 'accepted',
          sessionVersion: 1,
          payloadHash: input.payloadHash,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        commands.set(key, command);
        return { kind: 'accepted', command };
      },
      bindCommandExecution: (context: { commandId: string }, busId: string) => {
        for (const command of commands.values()) {
          if (command.commandId === context.commandId) {
            command.status = 'running';
            command.result = { busId };
          }
        }
      },
      terminalizeCommand: (input: {
        context: { commandId: string };
        status: string;
        reason: string;
      }) => {
        for (const command of commands.values()) {
          if (command.commandId === input.context.commandId) {
            command.status = input.status;
            command.reasonCode = input.reason;
          }
        }
      },
    } : null,
  } as unknown as ServerDeps;

  const app = new Hono();
  mountCompanyStreamRoutes(app, deps);

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  return { app, deps, post, commands, acceptCalls, prompts };
}

beforeEach(() => {
  H.orch = null;
  H.onSpawn = null;
  H.spawnGate = null;
  H.spawnError = null;
  H.companyFiles = null;
  H.resolveAndRunMaster.mockClear();
  H.ensureCompanyMasterLive.mockReset();
  H.ensureCompanyMasterLive.mockImplementation(async () => ({ orchestrator: H.orch }));
  H.normalizeAttachments.mockReset();
  H.persistAttachments.mockClear();
  H.normalizeAttachments.mockImplementation(async (attachments: unknown) => attachments);
});

describe('company POST /resume idempotency', () => {
  it('fails closed before sending when command authority is unavailable without a client key', async () => {
    const orch = makeOrch();
    H.orch = orch;
    const h = setup({}, new Map(), false);

    const response = await h.post(sessionPath('/resume'), {
      message: 'must not send',
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: 'IDEMPOTENCY_AUTHORITY_UNAVAILABLE',
    });
    expect(orch.sendMessageToMaster).not.toHaveBeenCalled();
  });

  it('a retry with the same client_msg_id does not re-send to the master', async () => {
    const orch = makeOrch();
    H.orch = orch;
    const h = setup();

    const r1 = await h.post(sessionPath('/resume'), { message: 'hi', client_msg_id: 'R1' });
    expect(r1.status).toBe(200);
    expect(orch.sendMessageToMaster).toHaveBeenCalledTimes(1);

    const r2 = await h.post(
      sessionPath('/resume'),
      { message: 'hi', client_msg_id: 'R1' },
      { 'Last-Event-ID': '0' },
    );
    expect(r2.status).toBe(200);
    expect(orch.sendMessageToMaster).toHaveBeenCalledTimes(1); // not re-sent

    markEnded(orch.metaBus as CoderRunBus, 'done', {});
    expect([...h.commands.values()][0]?.status).toBe('succeeded');
  });

  it('keeps a duplicate pending until worker delivery is acknowledged', async () => {
    const orch = makeOrch();
    H.orch = orch;
    let acknowledge!: (value: { ok: boolean }) => void;
    vi.mocked(orch.sendMessageToMaster).mockReturnValueOnce(
      new Promise((resolve) => { acknowledge = resolve; }),
    );
    const h = setup();
    const body = { message: 'ack first', client_msg_id: 'R-delivery-pending' };

    const owner = h.post(sessionPath('/resume'), body);
    await vi.waitFor(() => expect(orch.sendMessageToMaster).toHaveBeenCalledTimes(1));
    let duplicateSettled = false;
    const duplicate = Promise.resolve(
      h.post(sessionPath('/resume'), body),
    ).then((response) => {
      duplicateSettled = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(duplicateSettled).toBe(false);
    expect(h.acceptCalls).toHaveLength(1);

    acknowledge({ ok: true });
    expect((await owner).status).toBe(200);
    expect((await duplicate).status).toBe(200);
    expect(orch.sendMessageToMaster).toHaveBeenCalledTimes(1);
    markEnded(orch.metaBus as CoderRunBus, 'done', {});
  });

  it('awaits resume delivery and terminalizes the command when worker RPC rejects', async () => {
    const orch = makeOrch();
    H.orch = orch;
    vi.mocked(orch.sendMessageToMaster).mockRejectedValueOnce(new Error('worker rpc failed'));
    const h = setup();
    const body = { message: 'deliver once', client_msg_id: 'R-rpc-reject' };

    const first = await h.post(sessionPath('/resume'), body);
    expect(first.status).toBe(500);
    expect([...h.commands.values()][0]).toMatchObject({
      status: 'failed',
      reasonCode: 'company-resume-setup-failed',
    });

    const retry = await h.post(sessionPath('/resume'), body);
    expect(retry.status).toBe(200);
    expect(await retry.text()).toContain('event: error');
    expect(orch.sendMessageToMaster).toHaveBeenCalledTimes(1);
  });

  it('classifies an existing-worker ACK loss as OUTCOME_UNKNOWN and never replays it', async () => {
    const orch = makeOrch();
    H.orch = orch;
    vi.mocked(orch.sendMessageToMaster).mockRejectedValueOnce(portClosedError());
    const h = setup();
    const body = { message: 'deliver at most once', client_msg_id: 'R-port-closed-existing' };

    const first = await h.post(sessionPath('/resume'), body);
    expect(first.status).toBe(500);
    expect(await first.json()).toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(H.orch).toBeNull();
    expect([...h.commands.values()][0]).toMatchObject({
      status: 'failed',
      reasonCode: 'outcome_unknown',
    });

    const retry = await h.post(sessionPath('/resume'), body);
    expect(retry.status).toBe(200);
    expect(await retry.text()).toContain('OUTCOME_UNKNOWN');
    expect(orch.sendMessageToMaster).toHaveBeenCalledTimes(1);
  });

  it('classifies a fresh resume ACK loss as OUTCOME_UNKNOWN without respawning', async () => {
    H.onSpawn = makeOrch;
    H.resolveAndRunMaster.mockRejectedValueOnce(portClosedError());
    const h = setup();
    const body = { message: 'resume once', client_msg_id: 'R-port-closed-fresh' };

    const first = await h.post(sessionPath('/resume'), body);
    expect(first.status).toBe(500);
    expect(await first.json()).toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(H.orch).toBeNull();
    expect([...h.commands.values()][0]).toMatchObject({
      status: 'failed',
      reasonCode: 'outcome_unknown',
    });

    const retry = await h.post(sessionPath('/resume'), body);
    expect(retry.status).toBe(200);
    expect(await retry.text()).toContain('OUTCOME_UNKNOWN');
    expect(H.resolveAndRunMaster).toHaveBeenCalledTimes(1);
  });

  it('persists an error outcome synchronously and replays it without re-sending', async () => {
    const orch = makeOrch();
    H.orch = orch;
    const h = setup();
    expect((await h.post(sessionPath('/resume'), {
      message: 'hi',
      client_msg_id: 'R-error',
    })).status).toBe(200);

    markEnded(orch.metaBus as CoderRunBus, 'error', { reason: 'provider-error' });
    expect([...h.commands.values()][0]?.status).toBe('failed');
    const retry = await h.post(sessionPath('/resume'), {
      message: 'hi',
      client_msg_id: 'R-error',
    });
    expect(retry.status).toBe(200);
    expect(await retry.text()).toContain('event: error');
    expect(orch.sendMessageToMaster).toHaveBeenCalledTimes(1);
  });

  it('settles the remounted memory claim after a durable terminal for every later retry', async () => {
    const orch = makeOrch();
    H.orch = orch;
    const firstMount = setup();
    expect((await firstMount.post(sessionPath('/resume'), {
      message: 'once',
      client_msg_id: 'R-terminal-remount',
    })).status).toBe(200);
    markEnded(orch.metaBus as CoderRunBus, 'error', { reason: 'provider-error' });

    const remounted = setup({}, firstMount.commands);
    const firstRetry = await remounted.post(sessionPath('/resume'), {
      message: 'once',
      client_msg_id: 'R-terminal-remount',
    });
    expect(firstRetry.status).toBe(200);
    expect(await firstRetry.text()).toContain('event: error');

    const secondRetry = await Promise.race([
      remounted.post(sessionPath('/resume'), {
        message: 'once',
        client_msg_id: 'R-terminal-remount',
      }),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error('second durable-terminal retry did not settle')),
          250,
        );
        timer.unref?.();
      }),
    ]);
    expect(secondRetry.status).toBe(200);
    expect(await secondRetry.text()).toContain('event: error');
    expect(orch.sendMessageToMaster).toHaveBeenCalledTimes(1);
  });

  it('terminalizes a claimed resume when orchestrator setup throws and later retries never hang', async () => {
    H.spawnError = new Error('spawn failed');
    const h = setup();
    const body = { message: 'once', client_msg_id: 'R-spawn-failure' };

    expect((await h.post(sessionPath('/resume'), body)).status).toBe(500);
    expect([...h.commands.values()][0]).toMatchObject({
      status: 'failed',
      reasonCode: 'company-resume-failed',
    });

    for (let retry = 0; retry < 2; retry++) {
      const response = await Promise.race([
        h.post(sessionPath('/resume'), body),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`resume retry ${retry + 1} did not settle`)),
            250,
          );
          timer.unref?.();
        }),
      ]);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('event: error');
    }
    expect(H.resolveAndRunMaster).not.toHaveBeenCalled();
  });
});

describe('company POST /message delivery', () => {
  it('awaits worker RPC rejection instead of returning false success', async () => {
    const orch = makeOrch();
    H.orch = orch;
    vi.mocked(orch.sendMessageToMaster).mockRejectedValueOnce(new Error('bridge unavailable'));
    const h = setup();

    const response = await h.post(sessionPath('/message'), {
      message: 'must be acknowledged',
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      code: 'MASTER_MESSAGE_DELIVERY_FAILED',
      error: 'bridge unavailable',
    });
  });

  it('honors an async interactive-wait refusal', async () => {
    const orch = makeOrch();
    H.orch = orch;
    vi.mocked(orch.sendMessageToMaster).mockResolvedValueOnce({
      ok: false,
      pending: 'interactive_wait',
    });
    const h = setup();

    const response = await h.post(sessionPath('/message'), {
      message: 'answer elsewhere',
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'INTERACTION_PENDING' });
  });

  it('evicts a stale live worker and exposes ACK loss as OUTCOME_UNKNOWN', async () => {
    const orch = makeOrch();
    H.orch = orch;
    vi.mocked(orch.sendMessageToMaster).mockRejectedValueOnce(portClosedError());
    const h = setup();

    const response = await h.post(sessionPath('/message'), {
      message: 'do not replay',
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(H.orch).toBeNull();
    expect(orch.sendMessageToMaster).toHaveBeenCalledTimes(1);
  });
});

describe('company persisted prompt delivery', () => {
  it.each([
    {
      kind: 'plan' as const,
      path: sessionPath('/plan-response'),
      body: { approved: true, prompt_id: PROMPT_71 },
      promptId: PROMPT_71,
    },
    {
      kind: 'question' as const,
      path: sessionPath('/answer'),
      body: { answer: 'because', prompt_id: PROMPT_72 },
      promptId: PROMPT_72,
    },
  ])('keeps a pending $kind prompt unresolved when resume delivery fails', async ({
    kind,
    path,
    body,
    promptId,
  }) => {
    const h = setup();
    h.prompts.set(promptId, {
      id: promptId,
      company_session_id: SESSION_ID,
      kind,
      status: 'pending',
      answer: null,
      approved: null,
      feedback: null,
    });
    H.ensureCompanyMasterLive.mockResolvedValueOnce({
      error: 'resume failed before delivery',
      status: 500,
      code: 'MASTER_RESUME_FAILED',
    });

    const response = await h.post(path, body);

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      code: 'MASTER_RESUME_FAILED',
    });
    expect(h.prompts.get(promptId)?.status).toBe('pending');
  });

  it('never reports an already-resolved prompt as duplicate success', async () => {
    const h = setup();
    h.prompts.set(PROMPT_73, {
      id: PROMPT_73,
      company_session_id: SESSION_ID,
      kind: 'question',
      status: 'answered',
      answer: 'already sent',
      approved: null,
      feedback: null,
    });

    const response = await h.post(sessionPath('/answer'), {
      answer: 'retry',
      prompt_id: PROMPT_73,
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'PROMPT_ALREADY_RESOLVED',
    });
    expect(H.ensureCompanyMasterLive).not.toHaveBeenCalled();
  });

  it.each([
    {
      kind: 'plan' as const,
      path: sessionPath('/plan-response'),
      body: { approved: true, prompt_id: PROMPT_81 },
      promptId: PROMPT_81,
    },
    {
      kind: 'question' as const,
      path: sessionPath('/answer'),
      body: { answer: 'once', prompt_id: PROMPT_82 },
      promptId: PROMPT_82,
    },
  ])('serializes concurrent $kind delivery through completion', async ({
    kind,
    path,
    body,
    promptId,
  }) => {
    const h = setup();
    const deliveryOrchestrator = makeOrch();
    h.prompts.set(promptId, {
      id: promptId,
      company_session_id: SESSION_ID,
      kind,
      status: 'pending',
      answer: null,
      approved: null,
      feedback: null,
    });
    let acknowledge!: () => void;
    const gate = new Promise<void>((resolve) => { acknowledge = resolve; });
    H.ensureCompanyMasterLive.mockImplementationOnce(async () => {
      await gate;
      return { orchestrator: deliveryOrchestrator, resumed: true };
    });
    const first = h.post(path, body);
    await vi.waitFor(() => expect(H.ensureCompanyMasterLive).toHaveBeenCalledTimes(1));
    const second = h.post(path, body);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(H.ensureCompanyMasterLive).toHaveBeenCalledTimes(1);

    acknowledge();
    expect((await first).status).toBe(200);
    const duplicate = await second;
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ code: 'PROMPT_ALREADY_RESOLVED' });
    expect(H.ensureCompanyMasterLive).toHaveBeenCalledTimes(1);
    expect(h.prompts.get(promptId)).toMatchObject({
      status: 'answered',
      deliveryStatus: 'delivered',
    });
  });

  it('durably fences an unknown answer until an explicit same-payload retry', async () => {
    const h = setup();
    h.prompts.set(PROMPT_83, {
      id: PROMPT_83,
      company_session_id: SESSION_ID,
      kind: 'question',
      status: 'pending',
      answer: null,
      approved: null,
      feedback: null,
    });
    H.ensureCompanyMasterLive.mockResolvedValueOnce({
      error: 'worker acknowledgement lost',
      status: 500,
      code: 'OUTCOME_UNKNOWN',
    });

    const first = await h.post(sessionPath('/answer'), {
      answer: 'same answer',
      prompt_id: PROMPT_83,
    });
    expect(first.status).toBe(500);
    expect(await first.json()).toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(h.prompts.get(PROMPT_83)).toMatchObject({
      status: 'pending',
      deliveryStatus: 'outcome_unknown',
    });

    const implicitRetry = await h.post(sessionPath('/answer'), {
      answer: 'same answer',
      prompt_id: PROMPT_83,
    });
    expect(implicitRetry.status).toBe(409);
    expect(await implicitRetry.json()).toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(H.ensureCompanyMasterLive).toHaveBeenCalledTimes(1);

    const conflictingRetry = await h.post(sessionPath('/answer'), {
      answer: 'different answer',
      prompt_id: PROMPT_83,
      retry_outcome_unknown: true,
    });
    expect(conflictingRetry.status).toBe(409);
    expect(await conflictingRetry.json()).toMatchObject({
      code: 'PROMPT_DELIVERY_PAYLOAD_CONFLICT',
    });
    expect(H.ensureCompanyMasterLive).toHaveBeenCalledTimes(1);

    H.ensureCompanyMasterLive.mockResolvedValueOnce({
      orchestrator: makeOrch(),
      resumed: true,
    });
    const explicitRetry = await h.post(sessionPath('/answer'), {
      answer: 'same answer',
      prompt_id: PROMPT_83,
      retry_outcome_unknown: true,
    });
    expect(explicitRetry.status).toBe(200);
    expect(H.ensureCompanyMasterLive).toHaveBeenCalledTimes(2);
    expect(h.prompts.get(PROMPT_83)).toMatchObject({
      status: 'answered',
      deliveryStatus: 'delivered',
      answer: 'same answer',
    });
  });
});

describe('company POST /start idempotency', () => {
  it.each(['start', 'resume'])('preserves the real %s failure through idempotent SSE retries', async endpoint => {
    H.onSpawn = makeOrch;
    H.resolveAndRunMaster.mockRejectedValueOnce(new Error('Session writer unavailable'));
    const h = setup();
    const body = { ...(endpoint === 'start' ? { user_message: 'once' } : { message: 'once' }), client_msg_id: `failure-detail-${endpoint}` };
    const first = await h.post(sessionPath(`/${endpoint}`), body);
    expect(first.status).toBe(500);
    expect((await first.json()).error).toContain('Session writer unavailable');
    const replay = await h.post(sessionPath(`/${endpoint}`), body);
    expect(await replay.text()).toContain('Session writer unavailable');
    expect(H.resolveAndRunMaster).toHaveBeenCalledTimes(1);
  });
  it('classifies a start request timeout as OUTCOME_UNKNOWN and never auto-replays it', async () => {
    H.onSpawn = makeOrch;
    H.resolveAndRunMaster.mockRejectedValueOnce(requestTimeoutError());
    const h = setup();
    const body = { user_message: 'start once', client_msg_id: 'S-request-timeout' };

    const first = await h.post(sessionPath('/start'), body);
    expect(first.status).toBe(500);
    expect(await first.json()).toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(H.orch).toBeNull();
    expect([...h.commands.values()][0]).toMatchObject({
      status: 'failed',
      reasonCode: 'outcome_unknown',
    });

    const retry = await h.post(sessionPath('/start'), body);
    expect(retry.status).toBe(200);
    expect(await retry.text()).toContain('OUTCOME_UNKNOWN');
    expect(H.resolveAndRunMaster).toHaveBeenCalledTimes(1);
  });

  it('terminalizes a claimed start when orchestrator setup throws and later retries never hang', async () => {
    H.spawnError = new Error('spawn failed');
    const h = setup();
    const body = { user_message: 'once', client_msg_id: 'S-spawn-failure' };

    expect((await h.post(sessionPath('/start'), body)).status).toBe(500);
    expect([...h.commands.values()][0]).toMatchObject({
      status: 'failed',
      reasonCode: 'company-start-setup-failed',
    });

    for (let retry = 0; retry < 2; retry++) {
      const response = await Promise.race([
        h.post(sessionPath('/start'), body),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`start retry ${retry + 1} did not settle`)),
            250,
          );
          timer.unref?.();
        }),
      ]);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('event: error');
    }
    expect(H.resolveAndRunMaster).not.toHaveBeenCalled();
  });

  it('claims before attachment normalization and coalesces concurrent duplicates', async () => {
    H.onSpawn = makeOrch;
    const h = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    H.normalizeAttachments.mockImplementation(async (attachments: unknown) => {
      expect(h.commands.size).toBe(1);
      expect([...h.commands.values()][0]?.status).toBe('accepted');
      await gate;
      return attachments;
    });

    const first = h.post(sessionPath('/start'), {
      user_message: 'go',
      attachments: [{ name: 'a.txt', mediaType: 'text/plain', text: 'body' }],
      client_msg_id: 'concurrent-start',
    });
    await vi.waitFor(() => expect(H.normalizeAttachments).toHaveBeenCalledTimes(1));
    const duplicate = h.post(sessionPath('/start'), {
      user_message: 'go',
      attachments: [{ name: 'a.txt', mediaType: 'text/plain', text: 'body' }],
      client_msg_id: 'concurrent-start',
    });
    release();

    expect((await first).status).toBe(200);
    expect((await duplicate).status).toBe(200);
    expect(H.normalizeAttachments).toHaveBeenCalledTimes(1);
    expect(h.acceptCalls).toHaveLength(1);
    expect(H.resolveAndRunMaster).toHaveBeenCalledTimes(1);
    expect(H.persistAttachments).toHaveBeenCalledTimes(1);
    expect(H.resolveAndRunMaster.mock.calls[0]).toEqual(expect.arrayContaining([expect.objectContaining({ boardAttachments: [expect.objectContaining({ name: 'a.txt', size: 4 })] })]));
    markEnded(H.orch!.metaBus as CoderRunBus, 'done', {});
  });

  it('refuses a 33rd pre-bus owner before durable company-command acceptance', async () => {
    H.onSpawn = makeOrch;
    const h = setup();
    let releaseNormalization!: () => void;
    const gate = new Promise<void>((resolve) => { releaseNormalization = resolve; });
    H.normalizeAttachments.mockImplementation(async (attachments: unknown) => {
      await gate;
      return attachments;
    });

    const owners = Array.from({ length: 32 }, (_, index) =>
      h.post(sessionPath('/start'), {
        user_message: `owner-${index}`,
        client_msg_id: `company-owner-${index}`,
      }),
    );
    await vi.waitFor(
      () => expect(H.normalizeAttachments).toHaveBeenCalledTimes(32),
      { timeout: 3_000 },
    );
    expect(h.commands.size).toBe(32);

    const overflow = await h.post(sessionPath('/start'), {
      user_message: 'overflow',
      client_msg_id: 'company-owner-32',
    });
    expect(overflow.status).toBe(503);
    expect(await overflow.json()).toMatchObject({
      code: 'IDEMPOTENCY_CAPACITY_EXHAUSTED',
      retry_after_ms: 5_000,
    });
    expect(overflow.headers.get('Retry-After')).toBe('5');
    expect(h.commands.size).toBe(32);
    expect(h.acceptCalls).toHaveLength(32);

    releaseNormalization();
    await Promise.all(owners);
    if (H.orch) markEnded(H.orch.metaBus as CoderRunBus, 'done', {});
  });

  it('returns 409 for the same key with a different payload', async () => {
    H.onSpawn = makeOrch;
    const h = setup();
    expect((await h.post(sessionPath('/start'), {
      user_message: 'first',
      client_msg_id: 'payload-key',
    })).status).toBe(200);

    const conflict = await h.post(sessionPath('/start'), {
      user_message: 'different',
      client_msg_id: 'payload-key',
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: 'IDEMPOTENCY_PAYLOAD_CONFLICT' });
    expect(H.resolveAndRunMaster).toHaveBeenCalledTimes(1);
    markEnded(H.orch!.metaBus as CoderRunBus, 'done', {});
  });

  it('replays only the exact durably-bound bus after a route remount', async () => {
    H.onSpawn = makeOrch;
    const firstMount = setup();
    expect((await firstMount.post(sessionPath('/start'), {
      user_message: 'go',
      client_msg_id: 'remount-key',
    })).status).toBe(200);
    const exactBus = H.orch!.metaBus as CoderRunBus;
    publish(exactBus, 'worker_log', { marker: 'already-seen' });
    publish(exactBus, 'text_delta', { marker: 'must-replay' });

    const remounted = setup({}, firstMount.commands);
    const replay = await remounted.post(
      sessionPath('/start'),
      { user_message: 'go', client_msg_id: 'remount-key' },
      { 'Last-Event-ID': '0' },
    );
    expect(replay.status).toBe(200);
    expect(H.resolveAndRunMaster).toHaveBeenCalledTimes(1);
    expect([...remounted.commands.values()][0]?.result).toEqual({ busId: exactBus.busId });
    markEnded(exactBus, 'done', { reason: 'completed' });
    expect(await replay.text()).toContain('must-replay');
  });

  it('refuses a later unrelated bus and never reexecutes after restart', async () => {
    H.onSpawn = makeOrch;
    const firstMount = setup();
    expect((await firstMount.post(sessionPath('/start'), {
      user_message: 'go',
      client_msg_id: 'immutable-bus-key',
    })).status).toBe(200);
    const originalCalls = H.resolveAndRunMaster.mock.calls.length;

    H.orch = makeOrch();
    const remounted = setup({}, firstMount.commands);
    const retry = await remounted.post(sessionPath('/start'), {
      user_message: 'go',
      client_msg_id: 'immutable-bus-key',
    });
    expect(retry.status).toBe(200);
    expect(await retry.text()).toContain('executor-bus-unavailable');
    expect(H.resolveAndRunMaster).toHaveBeenCalledTimes(originalCalls);
    expect([...remounted.commands.values()][0]?.status).toBe('failed');
    markEnded(H.orch.metaBus as CoderRunBus, 'error', { reason: 'cleanup' });
  });

  it('a retry replays instead of the "Already running" 409', async () => {
    H.onSpawn = makeOrch;
    const h = setup();

    const r1 = await h.post(sessionPath('/start'), { user_message: 'go', client_msg_id: 'S1' });
    expect(r1.status).toBe(200);
    expect(H.resolveAndRunMaster).toHaveBeenCalledTimes(1);
    expect(H.resolveAndRunMaster).toHaveBeenCalledWith(
      expect.anything(),
      false,
      expect.objectContaining({ provider: 'anthropic', model: 'claude-sonnet-4-6' }),
    );

    // Orchestrator now exists → without dedup this retry would 409.
    const r2 = await h.post(
      sessionPath('/start'),
      { user_message: 'go', client_msg_id: 'S1' },
      { 'Last-Event-ID': '0' },
    );
    expect(r2.status).toBe(200);
    expect(H.resolveAndRunMaster).toHaveBeenCalledTimes(1); // no second master start

    markEnded(H.orch!.metaBus as CoderRunBus, 'done', {});
  });

  it('fails closed before spawn when an App Master runtime is incomplete', async () => {
    H.onSpawn = makeOrch;
    const h = setup({ runtime_kind: 'app_studio', config_json: '{}' });

    const response = await h.post(sessionPath('/start'), { user_message: 'go' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'MASTER_RUNTIME_INVALID' });
    expect(H.orch).toBeNull();
    expect(H.resolveAndRunMaster).not.toHaveBeenCalled();
  });

  it('uses the configured App Master', async () => {
    H.onSpawn = makeOrch;
    const h = setup({
      runtime_kind: 'app_studio',
      config_json: JSON.stringify({
        master_provider: 'openai-chatgpt',
        master_model: 'gpt-5.6-terra',
      }),
    });

    const response = await h.post(sessionPath('/start'), { user_message: 'go' });
    expect(response.status).toBe(200);
    expect(H.resolveAndRunMaster).toHaveBeenCalledWith(
      expect.anything(),
      false,
      expect.objectContaining({
        provider: 'openai-chatgpt',
        model: 'gpt-5.6-terra',
      }),
    );
    markEnded(H.orch!.metaBus as CoderRunBus, 'done', {});
  });

  it('a genuine second start (no key) still gets the "Already running" 409', async () => {
    const orch = makeOrch();
    H.orch = orch; // already running
    const h = setup();

    const res = await h.post(sessionPath('/start'), { user_message: 'go' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'Already running' });

    markEnded(orch.metaBus as CoderRunBus, 'done', {});
  });
});
