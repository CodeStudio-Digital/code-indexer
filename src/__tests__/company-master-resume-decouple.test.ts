import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock the slow/heavy dependencies of the resume path ──────────────
// `runCoder` boots the LLM loop; `buildMasterPromptInputs` provisions the
// sandbox (a cold container rebuild — the thing we decoupled from the RPC).
const mockRunCoder = vi.fn();
const mockBuildInputs = vi.fn();

vi.mock('@mcp/code-agent/index.js', () => ({
  runCoder: (...args: unknown[]) => mockRunCoder(...args),
}));
vi.mock('@mcp/code-agent/core/messages.js', () => ({
  attachmentsToBlocks: (message: string) => [{ type: 'text', text: message }],
}));
vi.mock('@mcp/company/services/master/prompt-builder.js', () => ({
  buildMasterPromptInputs: (...args: unknown[]) => mockBuildInputs(...args),
}));
vi.mock('@mcp/company/services/master/configure-skills.js', () => ({
  configureMasterSkills: vi.fn(),
}));

import { resumeMaster } from '@mcp/company/services/master/resume.js';

const COMPANY_SESSION_ID = 'c0000000-0000-4000-8000-000000000042';
const MASTER_AGENT_RUN_ID = 'a0000000-0000-4000-8000-000000000007';
const MASTER_CODER_SESSION_ID = 'd0000000-0000-4000-8000-000000000555';

/** A promise plus its resolve handle, so a test can control when it settles. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const MASTER_RUN = {
  id: MASTER_AGENT_RUN_ID,
  role: 'master',
  coder_session_id: MASTER_CODER_SESSION_ID,
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
};

/** Build a MasterResumeDeps whose `state` is backed by a mutable object. */
function makeDeps() {
  const calls = {
    board: [] as string[],
    setHandle: 0,
    attachCompletion: 0,
    agentRunStatus: [] as Array<[string, string]>,
    sessionStatus: [] as string[],
  };
  const resumeQueue: Array<{ message: string; attachments?: unknown[] }> = [];
  let resumingPromise: Promise<void> | null = null;
  let handle: unknown = null;

  const fakeRunner = {
    pushUserMessage: vi.fn(),
    pushUserContent: vi.fn(),
  };

  const deps = {
    ctx: {
      companySessionId: COMPANY_SESSION_ID,
      projects: [{ project_id: 1 }],
      runtimeKind: 'company',
      companyFiles: {
        sessionStore: {},
        listAgentRuns: async () => [MASTER_RUN],
        updateAgentRunStatus: async (id: string, s: string) => {
          calls.agentRunStatus.push([id, s]);
        },
        updateSessionStatus: async (s: string) => {
          calls.sessionStatus.push(s);
        },
        clearRecoveryFlag: async () => undefined,
      },
    },
    board: { post: (_a: string, _b: unknown, _c: string, msg: string) => calls.board.push(msg) },
    orchestratorRef: {},
    state: {
      get hasHandle() { return !!handle; },
      roleConfigs: [],
      allowedModels: [],
      setAgentRunId: () => undefined,
      setRuntimeSnapshot: () => undefined,
      setRoleConfigs: () => undefined,
      loadConfigFromDb: () => undefined,
      setCompanyContext: () => undefined,
      setPromptBlock: () => undefined,
      setLastUserAttachments: () => undefined,
      setHandle: (h: unknown) => { handle = h; calls.setHandle++; },
      setRunnerExited: () => undefined,
      get resumingPromise() { return resumingPromise; },
      setResumingPromise: (p: Promise<void> | null) => { resumingPromise = p; },
      get resumeQueue() { return resumeQueue; },
      drainResumeQueue: () => resumeQueue.splice(0, resumeQueue.length),
    },
    wireRunner: () => undefined,
    attachCompletion: () => { calls.attachCompletion++; },
  } as never;

  return { deps, calls, resumeQueue, fakeRunner, getResumingPromise: () => resumingPromise };
}

describe('resumeMaster — decoupled background provision', () => {
  beforeEach(() => {
    mockRunCoder.mockReset();
    mockBuildInputs.mockReset();
  });

  it('returns the ack BEFORE the sandbox provision (buildMasterPromptInputs) resolves', async () => {
    const provision = deferred<{ companyContext: unknown; promptBlock: string; configuredStack: null }>();
    mockBuildInputs.mockReturnValue(provision.promise);
    mockRunCoder.mockResolvedValue({
      session: { id: MASTER_CODER_SESSION_ID },
      runner: {},
      done: Promise.resolve(),
      indexStatus: null,
    });

    const { deps } = makeDeps();
    const ack = await resumeMaster({ userMessage: 'continue' } as never, deps);

    // The RPC-facing call resolved with the ids even though provisioning is
    // still pending — this is the fix: no blocking on the cold rebuild.
    expect(ack).toEqual({ masterSessionId: MASTER_CODER_SESSION_ID, indexStatus: null });
    expect(mockRunCoder).not.toHaveBeenCalled(); // gated behind the unresolved provision

    // Now let provisioning finish; the background task should boot the runner.
    provision.resolve({ companyContext: {}, promptBlock: '', configuredStack: null });
    await vi.waitFor(() => expect(mockRunCoder).toHaveBeenCalledOnce());
  });

  it('flips agent_run + session to running on the fast path, posts the resume board message', async () => {
    mockBuildInputs.mockReturnValue(deferred().promise); // never resolves this test
    const { deps, calls } = makeDeps();
    await resumeMaster({ userMessage: 'go' } as never, deps);
    expect(calls.agentRunStatus).toContainEqual([MASTER_AGENT_RUN_ID, 'running']);
    expect(calls.sessionStatus).toContain('running');
    expect(calls.board.some((m) => m.includes('Master resumed from existing session'))).toBe(true);
  });

  it('a second resume while provisioning queues the turn and does NOT re-provision', async () => {
    mockBuildInputs.mockReturnValue(deferred().promise); // keep first resume in-flight
    const { deps, resumeQueue } = makeDeps();

    await resumeMaster({ userMessage: 'first' } as never, deps);
    expect(mockBuildInputs).toHaveBeenCalledOnce();

    const ack2 = await resumeMaster({ userMessage: 'second' } as never, deps);
    // No second provision; the message is queued for the in-flight task.
    expect(mockBuildInputs).toHaveBeenCalledOnce();
    expect(ack2).toEqual({ masterSessionId: MASTER_CODER_SESSION_ID, indexStatus: null });
    expect(resumeQueue).toEqual([{ message: 'second', attachments: undefined }]);
  });

  it('flushes queued turns onto the runner once it is wired', async () => {
    const provision = deferred<{ companyContext: unknown; promptBlock: string; configuredStack: null }>();
    mockBuildInputs.mockReturnValue(provision.promise);
    const { deps, fakeRunner } = makeDeps();
    mockRunCoder.mockResolvedValue({
      session: { id: MASTER_CODER_SESSION_ID },
      runner: fakeRunner,
      done: Promise.resolve(),
      indexStatus: null,
    });

    await resumeMaster({ userMessage: 'first' } as never, deps);
    // A turn arrives during the provision window.
    await resumeMaster({ userMessage: 'queued-while-provisioning' } as never, deps);

    provision.resolve({ companyContext: {}, promptBlock: '', configuredStack: null });
    await vi.waitFor(() => expect(fakeRunner.pushUserMessage).toHaveBeenCalledWith('queued-while-provisioning'));
  });

  it('clears the in-flight promise after the background task settles', async () => {
    const provision = deferred<{ companyContext: unknown; promptBlock: string; configuredStack: null }>();
    mockBuildInputs.mockReturnValue(provision.promise);
    mockRunCoder.mockResolvedValue({
      session: { id: MASTER_CODER_SESSION_ID },
      runner: { pushUserMessage: vi.fn(), pushUserContent: vi.fn() },
      done: Promise.resolve(),
      indexStatus: null,
    });

    const { deps, getResumingPromise } = makeDeps();
    await resumeMaster({ userMessage: 'go' } as never, deps);
    expect(getResumingPromise()).not.toBeNull();

    provision.resolve({ companyContext: {}, promptBlock: '', configuredStack: null });
    await vi.waitFor(() => expect(getResumingPromise()).toBeNull());
  });

  it('marks agent_run + session error when the background task throws', async () => {
    mockBuildInputs.mockRejectedValue(new Error('docker exploded'));
    const { deps, calls } = makeDeps();

    await resumeMaster({ userMessage: 'go' } as never, deps);
    await vi.waitFor(() =>
      expect(calls.agentRunStatus).toContainEqual([MASTER_AGENT_RUN_ID, 'error']),
    );
    expect(calls.sessionStatus).toContain('error');
    expect(calls.board.some((m) => m.includes('Master resume failed'))).toBe(true);
  });
});
