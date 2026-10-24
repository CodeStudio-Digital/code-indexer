import { readFile, mkdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { nativeToolUseId } from '@mcp/agent-runtime-host';
import { resolve, join } from 'node:path';
import { agentV1Common as common, agentV1SessionStore as journal } from '../../../packages/agent-runtime-contracts/src/index.js';
import { ProviderGateway, parseRuntimePackageAnchor, verifyRuntimePackage, NativeSessionReader, NativeToolOutputStore, loadNativeHostBridge } from '../../../packages/agent-runtime-host/src/index.js';
import { prepareNativeCoderContext } from '../../../packages/code-agent/src/runtime/native-coder-context.js';
import { createNativeDocumentReader } from '../../../packages/code-agent/src/runtime/native-document-reader.js';
import { bindNativeProductProvider } from '../../../packages/code-agent/src/runtime/native-provider-binding.js';
import { HostEffectScope } from '../../../packages/code-agent/src/runtime/host-effect-scope.js';
import { createMutationFenceAuthority } from '../../../packages/code-agent/src/core/mutation-fence.js';
import { createToolRegistryCapabilityGatewayFactory } from '../../../packages/code-agent/src/runtime/tool-registry-host-capability-executor.js';
import { createHostCapabilityPolicy } from '../../../packages/code-agent/src/runtime/host-capability-policy.js';
import { PermissionGate, normalizeToolPermissionMode } from '../../../packages/code-agent/src/core/permission-gate.js';
import type { PreparedCoderInputs, PreparedCoderExecution, PreparedCoderOutcome } from '../../../packages/code-agent/src/runtime/prepared-coder-execution.js';
import type { MessageBridge } from '../../../packages/orchestrator-host/src/index.js';
import type { ControlPlaneRunContext } from '../../../packages/store/src/control-plane/index.js';
import { activateNativeCoderRuntimeFacade } from '../sse/native-coder-runtime-facade.js';
import { NativeCoderInteractions } from '../sse/native-coder-interactions.js';
import { nativeWorkspaceLeaseGroup } from '../native-workspace-lease-group.js';
import { publish, type CoderRunBus } from '../coder-bus.js';
import { workerNativeAuthority } from './native-authority-bridge.js';
import { nativeCoderExecutionBudget, type NativeCoderExecutionBudget } from './native-coder-budget.js';
import { NativeAuthorityRenewal } from './native-authority-renewal.js';
import { verifyNativeCoderWorkspace } from './native-worktree-preparation.js';
import { buildNativeCoderSpec } from './native-coder-spec.js';
import { nativeCoderWorkspaceAccess } from './native-coder-catalog.js';
import { NativeToolOutputMaterial } from './native-tool-output-material.js';
import { NativeShellPort } from './native-shell-port.js';
import { nativeFilesystemPort } from './native-filesystem-port.js';
import { NativePersistentCommandPort } from './native-persistent-command-port.js';
import { NativeBoundaryContextPreparation } from '@mcp/code-agent/runtime/native-boundary-context.js';
import { NativeInteractiveToolPort } from './native-interactive-tool-port.js';
import { registerNativeHistoryWriter } from '../native-history-writer.js';
import { inspectNativeContinuation, sealNativeContinuation, CONTINUATION_TASK, type NativeContinuationProof } from './native-coder-continuation.js';
import { NativeRootContinuation } from './native-root-continuation.js';
import { nativePreviewKey } from '@mcp/code-agent/tools/preview/authority.js';
import { nativeBrowserKey } from '@mcp/code-agent/tools/browser/authority.js';
import { NativeDatabasePort } from './native-database-port.js';
import { NativeSqliteProcess } from './native-sqlite-process.js';
import { NativeCodeExecutionPort } from './native-code-execution-port.js';
import { getDbToolsStore, getDbSecretDecryptor } from '@mcp/code-agent/tools/db/store-binding.js';
import { httpSessionCookieJar } from '@mcp/code-agent/tools/http.js';
import { NativeHttpPort } from './native-http-port.js';
import { NativeMemoryPort } from './native-memory-port.js';
import { NativeDocumentExportPort } from './native-document-export-port.js';
import { NativeProjectIndexPort } from './native-project-index-port.js';
import { NativeWebPort } from './native-web-port.js';
import { NativeLspPort } from './native-lsp-port.js';
import { getApiClientStore } from '@mcp/code-agent/tools/api-client/store-binding.js';
import { jarForProject } from '@mcp/code-agent/tools/api-client/shared.js';
import { NativeGoalPort } from './native-goal-port.js';
import { NativeTaskPort } from './native-task-port.js';
import { NativeCoderSharedTree, NativeCoderTreeOwner, nativeChildTranscriptRef,
  type NativeCoderChildExecution, type NativeCoderTreeOptions } from './native-coder-tree.js';
import { resolveNativeChildSessionRoot } from '../native-child-storage.js';
import { nativeCoderTreeOptions } from './native-coder-tree-options.js';
import { NativeAgentTreePort, snapshotNativeChildContext } from './native-agent-tree-port.js';
import { createWorkerAgentReadPort } from './agent-read-port.js';
import { NativeDocsResearchPort } from './native-docs-research-port.js';
import { NativeSessionReviewPort } from './native-session-review-port.js';
import { NativeWorktreeTransitionPort } from './native-worktree-transition-port.js';
import { assertNativeWorktreeTransitionMaterialized } from './native-worktree-transition-recovery.js';
import { isNativeTreeCoordinationTool, withNativeBackgroundDrain } from './native-background-provider.js';
import { isUncertainToolOutcomeError } from '@mcp/code-agent/core/uncertain-tool-outcome.js';
import type { NativeTreeInboxEntry } from '../native-tree-inbox.js';

export interface NativeCoderDevelopmentConfig {
  readonly mode: 'test';
  readonly context: ControlPlaneRunContext;
  readonly packageDirectory: string;
  readonly anchorPath: string;
  readonly sessionRoot: string;
  readonly workspaceRoot: string;
  readonly workspaceLeaseRoot: string;
  readonly sharedWorkspaceLeaseRoot?: string;
}

/** Explicit development cohort. The product worker supplies the real provider,
 * sealed tools and user context; no fixture authority or provider is injected. */
export async function executeNativeCoder(input: {
  prepared: PreparedCoderInputs;
  config: NativeCoderDevelopmentConfig;
  bridge: MessageBridge;
  runId: number;
  bus: CoderRunBus;
  tree?: NativeCoderTreeOptions;
  child?: NativeCoderChildExecution;
  workspaceBudget?: { execution: NativeCoderExecutionBudget; maxAgents: number };
  onWorkspaceBudgetClosed?: (snapshot: { execution: NativeCoderExecutionBudget;
    usage: { turns: number; toolCalls: number; agents: number }; maxAgents: number }) => void;
  assertOwner(): void;
}): Promise<PreparedCoderExecution> {
  const { prepared, config, bus, assertOwner } = input;
  if (input.child && (input.workspaceBudget || input.onWorkspaceBudgetClosed)) throw new Error('Native child cannot inherit a workspace transition budget');
  const childContext = snapshotNativeChildContext(prepared.toolContext);
  prepared.toolContext.sessionId = config.context.sessionId;
  prepared.toolContext.controlPlaneParentAgentRunId = config.context.agentRunId;
  if (config.mode !== 'test' || process.platform !== 'win32') throw new Error('Native development cohort requires Windows test mode');
  const workspaceRoot = await verifyNativeCoderWorkspace(config, prepared.preparation.environment, bus.ctrl.signal);
  if (normalizeRoot(prepared.toolContext.cwd) !== normalizeRoot(workspaceRoot)) {
    throw new Error('Native tool context differs from its verified workspace');
  }
  const workspaceAccess = nativeCoderWorkspaceAccess(prepared.registry.list(), !!input.child || (input.tree?.maxAgents ?? 1) > 1);
  assertOwner(); bus.ctrl.signal.throwIfAborted();
  const store = workerNativeAuthority(input.bridge, input.runId, config.context);
  const boundProvider = bindNativeProductProvider(prepared.provider, prepared.preparation);
  const state = await store.getAttemptState(config.context);
  if (!!state.run.parentAgentRunId !== !!input.child || input.child && (prepared.resume
    || input.child.admission.parentAgentRunId !== state.run.parentAgentRunId
    || input.child.shared.root.agentRunId !== state.command.agentRunId)) throw new Error('Native child execution requires its whole-tree owner');
  if (!input.child && !!prepared.resume !== (state.command.kind === 'resume')) throw new Error('Native continuation differs from its accepted command');
  const runtimePackage = await verifyRuntimePackage(config.packageDirectory,
    parseRuntimePackageAnchor(await readFile(config.anchorPath)));
  let storageEpoch = 1n;
  let rootContinuation: NativeRootContinuation | undefined;
  const readDocument = createNativeDocumentReader({ cwd: prepared.toolContext.cwd,
    projectName: prepared.toolContext.projectName, projectId: prepared.toolContext.projectId,
    globalWorkspace: prepared.toolContext.globalWorkspace, externalRoots: prepared.toolContext.externalRoots }, 16 * 1024 * 1024);
  let continuationProof: NativeContinuationProof | undefined = input.child?.continuation?.proof;
  const sessionRoot = input.child ? await resolveNativeChildSessionRoot(config.sessionRoot, config.context, true) : config.sessionRoot;
  const leases = input.child?.leases ?? nativeWorkspaceLeaseGroup(config, runtimePackage);
  const executionBudget = input.child?.executionBudget ?? input.workspaceBudget?.execution ?? nativeCoderExecutionBudget({ maxTurns: prepared.maxTurns,
    policy: prepared.preparation.policy.runtime?.execution, executorExpiresAt: state.attempt.executorLease.expiresAt });
  const sharedTree = input.child?.shared ?? new NativeCoderSharedTree(config.context, executionBudget,
    { ...(input.tree ?? nativeCoderTreeOptions(prepared)), ...(input.workspaceBudget ? { maxAgents: input.workspaceBudget.maxAgents } : {}) }, bus.ctrl.signal);
  const consumption = input.child?.consumption ?? sharedTree.budget.rootPort();
  if (input.child) { await leases.assertCurrent(input.child.lease); input.child.claim(config.context, workspaceRoot); }
  const lease = input.child?.lease ?? await leases.acquire({ root: workspaceRoot, access: workspaceAccess,
    ownerAgentRunId: config.context.agentRunId, attemptId: config.context.attemptId,
    expiresAtUnixMs: executionBudget.deadlineAtUnixMs,
    assertOwner: async () => { assertOwner(); await store.getAttemptState(config.context); assertOwner(); } });
  // User cancellation fences mutations immediately through bus.ctrl. Keep
  // pending policy responses alive until Control has acknowledged cancellation;
  // otherwise a denied response can start the next tool on the closing channel.
  const hostEffects = new AbortController();
  const contextPreparation = new NativeBoundaryContextPreparation(prepared.boundaryRecall ?? {}, hostEffects.signal);
  const renewal = new NativeAuthorityRenewal({ attemptId: config.context.attemptId,
    initialExpiresAtUnixMs: Date.parse(state.attempt.executorLease.expiresAt),
    hardDeadlineAtUnixMs: executionBudget.deadlineAtUnixMs,
    readExpiresAtUnixMs: async () => {
      assertOwner();
      const current = await store.getAttemptState(config.context);
      assertOwner(); return Date.parse(current.attempt.executorLease.expiresAt);
    },
    lost: (cause) => { hostEffects.abort(cause); bus.ctrl.abort(cause); },
  });
  const executionTimer = setTimeout(() => hostEffects.abort(new Error('Native execution deadline elapsed')),
    Math.max(1, executionBudget.executionDeadlineAtUnixMs - Date.now()));
  executionTimer.unref();
  prepared.toolContext.signal = hostEffects.signal;
  prepared.toolContext.ports = { ...prepared.toolContext.ports, discovery: {
    capabilitySetDigest: prepared.preparation.capabilitySet.hash,
    visibleToolNames: new Set(prepared.preparation.capabilityDescriptors
      .filter(d => prepared.preparation.capabilitySet.visible.includes(d.capabilityId)).map(d => d.name)),
    eligibleCapabilityIds: new Set(prepared.preparation.capabilitySet.eligible),
    assertCurrent: () => { assertOwner(); hostEffects.signal.throwIfAborted(); bus.ctrl.signal.throwIfAborted(); },
  } };
  prepared.toolContext.onDiagramChanged = payload => {
    assertOwner(); hostEffects.signal.throwIfAborted(); bus.ctrl.signal.throwIfAborted();
    publish(bus, 'diagram_changed', payload);
  };
  const interactions = new NativeCoderInteractions(hostEffects.signal);
  const reviews = new NativeInteractiveToolPort(prepared.preparation.agentDefinitionId,
    prepared.preparation.policy.specMode, interactions, (event, data) => publish(bus, event, data),
    () => { assertOwner(); hostEffects.signal.throwIfAborted(); bus.ctrl.signal.throwIfAborted(); });
  prepared.toolContext.ports = { ...prepared.toolContext.ports, interactions: reviews };
  const setSessionAgent = prepared.toolContext.setSessionAgent;
  if (setSessionAgent) prepared.toolContext.setSessionAgent = async agent => {
    await setSessionAgent(agent); publish(bus, 'session_agent_changed', { agent });
  };
  const effects = new HostEffectScope();
  const toolMaterial = new NativeToolOutputMaterial(config.context.sessionId);
  let activeRuntime: Pick<import('@mcp/agent-runtime-host').NativeRustHostAttemptRuntime,
    'commitAttachment' | 'waitForPhysicalReap'> | undefined;
  const outputStore = new NativeToolOutputStore({ sessionId: config.context.sessionId,
    signal: hostEffects.signal, assertOwner,
    commit: (reference, reader, signal) => effects.track(async () => {
      if (!activeRuntime) throw new Error('Native output has no authorized writer');
      await activeRuntime.commitAttachment(reference, reader, signal);
    }),
    openReader: () => NativeSessionReader.open(runtimePackage,
      { rootPath: sessionRoot, sessionId: config.context.sessionId }),
  });
  prepared.toolContext.toolOutputStore = outputStore;
  let material: Awaited<ReturnType<typeof prepareNativeCoderContext>> | undefined;
  let continuation: ReturnType<typeof sealNativeContinuation> | undefined;
  let launched = false;
  let activationStarted = false;
  let releaseRuntimeResources: (() => void) | undefined;
  let shell: NativeShellPort | undefined;
  let commands: NativePersistentCommandPort | undefined;
  let databases: NativeDatabasePort | undefined;
  let http: NativeHttpPort | undefined;
  let apiHttp: NativeHttpPort | undefined;
  let web: NativeWebPort | undefined;
  let lsp: NativeLspPort | undefined;
  let goals: NativeGoalPort | undefined;
  const treeOwner = new NativeCoderTreeOwner(input, store, sharedTree, leases, lease, async () => {
    await effects.waitForOtherEffects(bus.ctrl.signal);
    shell?.assertQuiescent(); commands?.assertQuiescent();
  }, runtimePackage);
  treeOwner.bindInputInterrupt(() => reviews.interruptForAgent());
  const treeContextPreparation = treeOwner.mailboxPreparation(contextPreparation);
  const treeProvider = withNativeBackgroundDrain(boundProvider, async () => {
    try { await treeOwner.drainBackground(); }
    catch (cause) { if (isUncertainToolOutcomeError(cause)) uncertainExternalEffect = true; throw cause; }
  });
  prepared.toolContext.planMode = prepared.preparation.policy.planMode;
  prepared.toolContext.ports = { ...prepared.toolContext.ports, agentTree: new NativeAgentTreePort(treeOwner, prepared,
    childContext, Math.min(executionBudget.executionDeadlineAtUnixMs, Date.parse(state.attempt.executorLease.expiresAt)),
    () => ({ planMode: prepared.preparation.policy.planMode && !reviews.planApproved,
      specMode: prepared.preparation.policy.specMode && !reviews.specApproved })) };
  if (prepared.registry.has('docs_deep_research')) prepared.toolContext.ports = { ...prepared.toolContext.ports,
    docsResearch: new NativeDocsResearchPort(treeOwner, prepared, childContext,
      Math.min(executionBudget.executionDeadlineAtUnixMs, Date.parse(state.attempt.executorLease.expiresAt)),
      () => ({ planMode: prepared.preparation.policy.planMode && !reviews.planApproved,
        specMode: prepared.preparation.policy.specMode && !reviews.specApproved })) };
  const worktrees = !input.child && prepared.registry.list().some(t => t.name === 'enter_worktree' || t.name === 'exit_worktree')
    ? new NativeWorktreeTransitionPort(config.workspaceRoot, workspaceRoot,
      () => { assertOwner(); hostEffects.signal.throwIfAborted(); bus.ctrl.signal.throwIfAborted(); leases.assertCurrentForMutation(lease); }) : undefined;
  if (worktrees) prepared.toolContext.ports = { ...prepared.toolContext.ports, worktree: worktrees };
  if (prepared.toolContext.agentReads) prepared.toolContext.agentReads = createWorkerAgentReadPort(input.bridge, input.runId,
    AbortSignal.any([hostEffects.signal, bus.ctrl.signal]), () => { assertOwner(); hostEffects.signal.throwIfAborted(); bus.ctrl.signal.throwIfAborted(); },
    config.context.agentRunId);
  const tasks = new NativeTaskPort(prepared.toolContext,
    () => { assertOwner(); hostEffects.signal.throwIfAborted(); bus.ctrl.signal.throwIfAborted(); },
    (event, data) => publish(bus, event, data));
  if (prepared.registry.has('self_review')) prepared.toolContext.ports = { ...prepared.toolContext.ports,
    sessionReview: new NativeSessionReviewPort(config.context.sessionId, config.context.agentRunId,
      lease.root, () => { assertOwner(); leases.assertCurrentForMutation(lease); }) };
  let unregisterHistory: (() => void) | undefined;
  let uncertainExternalEffect = false;
  prepared.toolContext.externalMcpAuthority = { payload: { lease, sharedLease: leases.sharedLease },
    outcomeUnknown: () => { uncertainExternalEffect = true; } };
  const hasPreview = prepared.registry.list().some(tool => tool.name.startsWith('preview_'));
  const hasMemoryWrites = prepared.registry.has('remember') || prepared.registry.has('forget_memory') || prepared.registry.has('mcp__save_memory');
  const hasDocumentExport = prepared.registry.has('mcp__export_docs');
  const hasProjectIndex = prepared.registry.has('mcp__index_project');
  if (hasProjectIndex) prepared.toolContext.ports = { ...prepared.toolContext.ports, projectIndex: new NativeProjectIndexPort({
    bridge: input.bridge, runId: input.runId, agentRunId: config.context.agentRunId, key: `coder-${config.context.sessionId}-attempt-${config.context.attemptId}`,
    payload: { lease, sharedLease: leases.sharedLease }, signal: hostEffects.signal, effects,
    assertCurrent: () => { assertOwner(); bus.ctrl.signal.throwIfAborted(); leases.assertCurrentForMutation(lease); },
    outcomeUnknown: () => { uncertainExternalEffect = true; },
  }) };
  if (hasDocumentExport) prepared.toolContext.ports = { ...prepared.toolContext.ports, documentExport: new NativeDocumentExportPort({
    bridge: input.bridge, runId: input.runId, agentRunId: config.context.agentRunId, key: `coder-${config.context.sessionId}-attempt-${config.context.attemptId}`,
    payload: { lease, sharedLease: leases.sharedLease }, signal: hostEffects.signal, effects,
    assertCurrent: () => { assertOwner(); bus.ctrl.signal.throwIfAborted(); leases.assertCurrentForMutation(lease); },
    outcomeUnknown: () => { uncertainExternalEffect = true; },
  }) };
  if (hasMemoryWrites) prepared.toolContext.ports = { ...prepared.toolContext.ports, memoryMutations: new NativeMemoryPort({
    bridge: input.bridge, runId: input.runId, agentRunId: config.context.agentRunId, key: `coder-${config.context.sessionId}-attempt-${config.context.attemptId}`,
    payload: { lease, sharedLease: leases.sharedLease }, signal: hostEffects.signal, effects,
    assertCurrent: () => { assertOwner(); bus.ctrl.signal.throwIfAborted(); leases.assertCurrentForMutation(lease); },
    outcomeUnknown: () => { uncertainExternalEffect = true; },
  }) };
  const hasBrowser = prepared.registry.list().some(tool => tool.name.startsWith('browser_'));
  if (hasPreview) prepared.toolContext.previewAuthority = { payload: { lease, sharedLease: leases.sharedLease },
    key: nativePreviewKey(config.context.sessionId, config.context.attemptId), runId: input.runId,
    outcomeUnknown: () => { uncertainExternalEffect = true; } };
  if (hasBrowser) prepared.toolContext.browserAuthority = { payload: { lease, sharedLease: leases.sharedLease },
    key: nativeBrowserKey(config.context.sessionId, config.context.attemptId), runId: input.runId,
    outcomeUnknown: () => { uncertainExternalEffect = true; } };
  const closeApplications = async () => {
    const drains = [hasPreview && 'previewDevtoolsDrain', hasBrowser && 'researchBrowserDrain', hasMemoryWrites && 'nativeMemoryDrain', hasDocumentExport && 'nativeExportDrain', hasProjectIndex && 'nativeIndexDrain'].filter(Boolean) as string[];
    const results = await Promise.allSettled([lsp?.close(), http?.close(), apiHttp?.close(), web?.close(), databases?.close(), ...drains.map(async channel => {
      const result = await input.bridge.request<{ closed: boolean }>(channel,
        { runId: input.runId, agentRunId: config.context.agentRunId, attemptId: config.context.attemptId }, { timeoutMs: 30_000 });
      if (result?.closed !== true) throw new Error(`Native application cleanup lacks confirmation: ${channel}`);
    })]);
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  };
  try {
    if (input.child?.continuation?.inbox) await treeOwner.restoreInbox(input.child.continuation.inbox);
    if (prepared.registry.list().some(tool => ['create_goal', 'get_goal', 'update_goal'].includes(tool.name))) {
      goals = new NativeGoalPort(prepared.toolContext,
        () => { assertOwner(); hostEffects.signal.throwIfAborted(); bus.ctrl.signal.throwIfAborted(); });
    }
    // Inspect after acquiring the workspace authority, so the previous writer
    // cannot still execute effects while we choose the continuation frontier.
    try {
      await stat(join(sessionRoot, config.context.sessionId, 'session.json'));
      const reader = await NativeSessionReader.open(runtimePackage, { rootPath: sessionRoot, sessionId: config.context.sessionId });
      try {
        if (reader.state.archived || reader.state.authority!.writerId === config.context.attemptId) {
          throw new Error('Existing native attempt requires explicit recovery, not a fresh dispatch');
        }
        storageEpoch = reader.state.authority!.leaseEpoch + 1n;
        continuationProof = await inspectNativeContinuation(reader, !!prepared.resume, undefined, {
          assertWorkspaceTransition: source => assertNativeWorktreeTransitionMaterialized(config, source, workspaceRoot, bus.ctrl.signal),
        });
        if (prepared.resume && !input.child && continuationProof) rootContinuation = await NativeRootContinuation.open(reader, continuationProof,
          { sessionId: config.context.sessionId, messages: prepared.messages, readDocument, signal: bus.ctrl.signal });
      } finally { await reader.close(); }
    } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause; }
    if (prepared.resume && !continuationProof) throw new Error('Native continuation requires an existing validated session');
    if (!input.child && continuationProof) {
      const inbox = await input.bridge.request<NativeTreeInboxEntry[]>('native.authority', {
        runId: input.runId, agentRunId: config.context.agentRunId,
        operation: { kind: 'continuationInbox', source: {
          agentRunId: continuationProof.sourceAgentRunId, attemptId: continuationProof.sourceAttemptId,
        } },
      }, { timeoutMs: 30_000 });
      await treeOwner.restoreInbox(inbox);
    }
    if (continuationProof && !await store.commitRuntimeRequest(config.context, 'continuation:source', continuationProof)) {
      throw new Error('Native continuation was already admitted; reconcile its original attempt before retrying');
    }
    const binding = loadNativeHostBridge(runtimePackage);
    const contained = sharedTree.resources.bind(binding);
    if (prepared.registry.has('code_exec')) {
      if (!contained.startDuplex) throw new Error('Native code_exec requires contained duplex process support');
      prepared.toolContext.ports = { ...prepared.toolContext.ports, codeExecution: new NativeCodeExecutionPort({
        spawn: contained.startDuplex, root: workspaceRoot, deadline: lease.expiresAtUnixMs,
        signal: AbortSignal.any([hostEffects.signal, bus.ctrl.signal]),
        assertOwner: () => { assertOwner(); hostEffects.signal.throwIfAborted(); bus.ctrl.signal.throwIfAborted(); },
        outcomeUnknown: () => { uncertainExternalEffect = true; },
      }) };
    }
    const startCommand = contained.startCommand;
    if (prepared.registry.has('manage_path')) {
      const rename = loadNativeHostBridge(runtimePackage).renameNativePathNoReplace;
      if (!rename) throw new Error('Native path management requires atomic exclusive rename');
      prepared.toolContext.ports = { ...prepared.toolContext.ports, fs: nativeFilesystemPort({
        prepared: prepared.toolContext.ports?.fs, root: lease.root, rename,
        assertCurrent: () => { assertOwner(); hostEffects.signal.throwIfAborted(); bus.ctrl.signal.throwIfAborted(); leases.assertCurrentForMutation(lease); },
      }) };
    }
    if (prepared.registry.list().some(tool => ['exec_command', 'write_stdin', 'list_sessions'].includes(tool.name))) {
      const startDuplex = contained.startDuplex;
      if (!startDuplex || binding.nativeHostBridgeAbi().duplexOutputVersion !== 1) {
        throw new Error('Native runtime package does not support contained persistent commands');
      }
      commands = new NativePersistentCommandPort(startDuplex, lease.expiresAtUnixMs, hostEffects.signal,
        () => { uncertainExternalEffect = true; }, binding.nativeHostBridgeAbi().pseudoconsoleVersion === 1);
      prepared.toolContext.ports = { ...prepared.toolContext.ports, commands };
    }
    if (prepared.registry.list().some(tool => tool.effectBoundary === 'shell')) {
      if (!startCommand) throw new Error('Native runtime package does not support contained Host commands');
      shell = new NativeShellPort(startCommand, lease.expiresAtUnixMs, hostEffects.signal);
      prepared.toolContext.ports = { ...prepared.toolContext.ports, shell };
    }
    if (workspaceAccess === 'exclusive_write') {
      prepared.toolContext.mutationFence = createMutationFenceAuthority({ mode: 'enforce', authorizedRoot: lease.root,
        authorizedRootAliases: [prepared.toolContext.projectName],
        assertLease: invocation => {
          assertOwner(); bus.ctrl.signal.throwIfAborted();
          if (invocation && isNativeTreeCoordinationTool(invocation.toolName)) {
            leases.assertCurrentForCoordination(lease);
          } else leases.assertCurrentForMutation(lease);
        },
        snapshot: () => ({ environmentId: lease.environmentId, environmentVersion: lease.environmentVersion,
          workspaceLeaseId: lease.leaseId, workspaceLeaseVersion: lease.version,
          workspaceFencingEpoch: lease.fencingEpoch, ownerAgentRunId: lease.ownerAgentRunId }),
      });
    }
    if (prepared.registry.has('http_request')) {
      http = new NativeHttpPort({ signal: AbortSignal.any([hostEffects.signal, bus.ctrl.signal]), effects,
        jar: httpSessionCookieJar(prepared.toolContext), outcomeUnknown: () => { uncertainExternalEffect = true; },
        assertOwner: () => { assertOwner(); bus.ctrl.signal.throwIfAborted(); leases.assertCurrentForMutation(lease); } });
      prepared.toolContext.ports = { ...prepared.toolContext.ports, http };
    }
    if (prepared.registry.has('web_fetch') || prepared.registry.has('web_search')) {
      web = new NativeWebPort({ signal: AbortSignal.any([hostEffects.signal, bus.ctrl.signal]), effects,
        assertOwner: () => { assertOwner(); hostEffects.signal.throwIfAborted(); bus.ctrl.signal.throwIfAborted(); } });
      prepared.toolContext.ports = { ...prepared.toolContext.ports, web };
    }
    if (prepared.registry.list().some(tool => tool.name.startsWith('lsp_'))) {
      const spawn = contained.startDuplex;
      if (!spawn) throw new Error('Native LSP requires contained duplex process support');
      lsp = new NativeLspPort(AbortSignal.any([hostEffects.signal, bus.ctrl.signal]),
        () => { assertOwner(); hostEffects.signal.throwIfAborted(); bus.ctrl.signal.throwIfAborted(); },
        { spawn, deadline: lease.expiresAtUnixMs });
      prepared.toolContext.ports = { ...prepared.toolContext.ports, lsp };
    }
    if (prepared.registry.list().some(tool => tool.name.startsWith('api_'))) {
      const projectId = prepared.toolContext.projectId;
      if (!getApiClientStore() || projectId == null) throw new Error('Native API client has no project store');
      const assertCurrent = () => { assertOwner(); hostEffects.signal.throwIfAborted(); bus.ctrl.signal.throwIfAborted(); leases.assertCurrentForMutation(lease); };
      apiHttp = new NativeHttpPort({ signal: AbortSignal.any([hostEffects.signal, bus.ctrl.signal]), effects,
        jar: jarForProject(projectId), assertOwner: assertCurrent, outcomeUnknown: () => { uncertainExternalEffect = true; } });
      prepared.toolContext.ports = { ...prepared.toolContext.ports, apiClient: { projectId, http: apiHttp, assertCurrent } };
    }
    if (prepared.registry.list().some(tool => tool.name.startsWith('db_'))) {
      const connectionStore = getDbToolsStore();
      if (!connectionStore) throw new Error('Native database catalog has no project connection store');
      databases = new NativeDatabasePort({ projectId: prepared.toolContext.projectId ?? -1, store: connectionStore,
        signal: AbortSignal.any([hostEffects.signal, bus.ctrl.signal]), effects,
        decrypt: getDbSecretDecryptor(), outcomeUnknown: () => { uncertainExternalEffect = true; },
        createDriver: async connection => {
          if (connection.engine !== 'sqlite') return (await import('@mcp/db-drivers/factory.js')).createDriver(connection);
          const spawn = contained.startDuplex;
          if (!spawn) throw new Error('Native SQLite requires contained duplex process support');
          return new NativeSqliteProcess({ spawn, root: workspaceRoot, deadline: lease.expiresAtUnixMs,
            signal: AbortSignal.any([hostEffects.signal, bus.ctrl.signal]),
            assertOwner: () => { assertOwner(); bus.ctrl.signal.throwIfAborted(); leases.assertCurrentForMutation(lease); },
            outcomeUnknown: () => { uncertainExternalEffect = true; },
          }).initialize(connection);
        },
        assertOwner: () => { assertOwner(); bus.ctrl.signal.throwIfAborted(); leases.assertCurrentForMutation(lease); } });
      prepared.toolContext.ports = { ...prepared.toolContext.ports, database: databases };
    }
    const assertSessionCurrent = () => {
      assertOwner(); hostEffects.signal.throwIfAborted(); bus.ctrl.signal.throwIfAborted();
    };
    if (prepared.toolContext.sessionDrive) prepared.toolContext.sessionDrive = {
      ...prepared.toolContext.sessionDrive, assertCurrent: assertSessionCurrent,
    };
    if (prepared.toolContext.conversationHistory) prepared.toolContext.conversationHistory = {
      ...prepared.toolContext.conversationHistory, assertCurrent: assertSessionCurrent,
    };
    material = await prepareNativeCoderContext({ preparation: prepared.preparation, registry: prepared.registry,
      systemPrompt: prepared.systemPrompt, preparedUserContext: prepared.resume ? undefined : prepared.preparedUserContext, messages: prepared.resume
        ? [{ role: 'user', content: [{ type: 'text', text: CONTINUATION_TASK }] }]
        : prepared.messages, maximumBytes: 8 * 1024 * 1024,
      readDocument,
      thinking: prepared.thinking, thinkingBudgetTokens: prepared.thinkingBudgetTokens, signal: bus.ctrl.signal });
    if (input.child?.continuation) {
      const guidance = prepared.messages[0];
      if (prepared.messages.length !== 1 || guidance?.role !== 'user' || guidance.content.length !== 1
        || guidance.content[0]?.type !== 'text') throw new Error('Native child resume requires one explicit guidance message');
      continuation = input.child.continuation.prepare(material, config.context.agentRunId, guidance.content[0].text);
    } else continuation = rootContinuation?.prepare(material, config.context.agentRunId);
    const composition = buildNativeCoderSpec({ prepared, material, context: config.context,
      state, lease, executionBudget, treeLimits: sharedTree.budget.limits, sessionRoot, storageEpoch, continuation });
    await mkdir(sessionRoot, { recursive: true });
    prepared.toolContext.permissionGate = new PermissionGate({
      getMode: () => normalizeToolPermissionMode(prepared.preparation.policy.permissionMode),
      waitForUserInput: (id) => interactions.waitForInput(id),
      emit: (event, payload) => publish(bus, event, payload),
    });
    const policy = createHostCapabilityPolicy({ registry: prepared.registry, toolContext: prepared.toolContext,
      getPolicyContext: () => ({ planMode: prepared.preparation.policy.planMode, planApproved: reviews.planApproved,
        specMode: prepared.preparation.policy.specMode, specApproved: reviews.specApproved, taskScope: tasks.currentScope() }),
      readAuthority: async () => {
        assertOwner();
        await store.getAttemptState(config.context);
        await leases.assertCurrent(lease);
        assertOwner();
        return { attemptId: config.context.attemptId, environmentId: lease.environmentId,
          environmentVersion: lease.environmentVersion, workspaceLeaseId: lease.leaseId,
          workspaceLeaseVersion: lease.version, workspaceFencingEpoch: lease.fencingEpoch,
          deadlineAtUnixMs: BigInt(lease.expiresAtUnixMs), policyVersion: composition.spec.policySnapshot!.ref };
      },
    });
    const gateway = createToolRegistryCapabilityGatewayFactory({ registry: prepared.registry,
      invocationBudget: consumption,
      maximumToolCalls: executionBudget.maxToolCalls,
      capabilitySet: prepared.preparation.capabilitySet, wireSnapshot: material.capabilitySnapshot,
      toolContext: prepared.toolContext, effects, ...policy,
      cancelledQuestionWithoutResponse: request => interactions.wasCancelledWithoutResponse(
        nativeToolUseId(request.identity.attemptId, request.providerOperationId, request.toolUseId)),
      commitResult: input => effects.track(async () => {
        if (!activeRuntime) throw new Error('Native tool result has no runtime owner');
        const material = await toolMaterial.commit(input.result.extraUserBlocks, activeRuntime, hostEffects.signal);
        const nativeGoal = goals?.result(input);
        const nativeTasks = tasks.result(input);
        const nativeWorktreeTransition = worktrees?.result(input);
        return material || nativeGoal || nativeTasks || nativeWorktreeTransition
          ? { ...material, ...(nativeGoal ? { nativeGoal } : {}), ...(nativeTasks ? { nativeTasks } : {}),
            ...(nativeWorktreeTransition ? { nativeWorktreeTransition } : {}) } : undefined;
      }) });
    const attached = await activateNativeCoderRuntimeFacade({ ...composition, store, context: config.context,
      beforeSupervisorSpawn: () => {
        assertOwner();
        bus.ctrl.signal.throwIfAborted();
        hostEffects.signal.throwIfAborted();
        releaseRuntimeResources = contained.reserveRuntime();
        activationStarted = true;
      },
      transcriptRef: input.child ? nativeChildTranscriptRef(config.context, input.child.shared.root.attemptId) : undefined,
      onUncertainEffect: () => { uncertainExternalEffect = true; },
      runtimePackage, integrationMode: 'test', bus, environmentKind: prepared.preparation.environment.kind, assertOwner,
      requiredContainmentLevel: common.ContainmentLevel.HARD_PROCESS,
      requiredEnforcedLimits: [common.ResourceLimitKind.MEMORY],
      capabilityCatalogVersion: prepared.preparation.capabilitySet.catalogVersion,
      capabilityIds: prepared.preparation.capabilitySet.visible,
      beforeTerminalCommit: async record => {
        if (record.body.case !== 'terminal') throw new Error('Native terminal barrier received a nonterminal record');
        // Normal final provider output already waited for background work.
        // Pauses, errors and cancellation must stop children before authority
        // closes, rather than wait for new work under the terminal Data ACK.
        try { await treeOwner.close(); }
        catch (cause) { if (isUncertainToolOutcomeError(cause)) uncertainExternalEffect = true; throw cause; }
      },
      provideInput: (id, value) => interactions.provideInput(id, value),
      isInteractionPending: id => interactions.hasPending(id),
      stopHostEffects: () => { void renewal.close(); hostEffects.abort(); },
      drainHostEffects: async () => {
        await renewal.close();
        let closeError: unknown;
        try { await closeOwnedCommands(effects, shell, commands, closeApplications, () => treeOwner.close()); }
        catch (cause) { closeError = cause; if (isUncertainToolOutcomeError(cause)) uncertainExternalEffect = true; }
        if (!activeRuntime) throw new Error('Native physical runtime is unavailable');
        await activeRuntime.waitForPhysicalReap();
        releaseRuntimeResources?.();
        // A child outcome can remain unknown after all owned processes exit.
        // Release physical resource accounting while retaining its workspace fence.
        if (closeError !== undefined) throw closeError;
        // Reaping Rust does not prove completion of a remote mutation. Preserve
        // its exclusive lease until explicit reconciliation; never replay it.
        if (!uncertainExternalEffect) await leases.release(lease, async () => {
          await effects.waitForIdle();
        });
      },
      resolveToolUserMessage: (encoded) => toolMaterial.resolvePreview(encoded),
      capabilityGatewayFactory: gateway,
      sessionStoreReady: async (sessionStore) => {
        for (const reference of material!.artifacts) await sessionStore.commitAttachment(reference, material!.artifactReader, bus.ctrl.signal);
        for (const reference of input.child?.continuation?.artifacts ?? []) {
          await sessionStore.commitAttachment(reference, input.child!.continuation!.artifactReader, bus.ctrl.signal);
        }
      },
      runtimeCreated: async (runtime) => {
        activeRuntime = runtime;
        // Stop pending interactions/tools on a soft channel boundary. Any
        // uncertain external mutation still follows the reconciliation path.
        runtime.identityBudgetSignal.addEventListener('abort',
          () => hostEffects.abort(new Error('Native IPC identity budget reached')), { once: true });
        if (!input.child) unregisterHistory = registerNativeHistoryWriter(config.context.sessionId, { attemptId: config.context.attemptId, runtime });
        if (!input.child) input.tree?.ready?.(treeOwner);
      },
      providerGatewayFactory: (context, clock) => new ProviderGateway({ runtimeInstanceId: context.runtimeInstanceId,
        admitOperation: (identity, signal) => consumption.admitProviderOperation(identity, signal),
        contextPreparation: treeContextPreparation,
        limits: { maxOperationMs: Number(composition.spec.resourceBudget!.maxWallMs) },
        resolver: { resolve(binding) {
          if (binding.effectiveProvider !== prepared.preparation.provider || binding.effectiveModel !== prepared.preparation.model) {
            throw new Error('Native provider selection differs from the user session');
          }
          return treeProvider;
        } }, artifactReader: { read: (reference, maximumBytes, signal) => toolMaterial.hasArtifact(reference.artifactId)
          ? toolMaterial.artifactReader.read(reference, maximumBytes, signal)
          : input.child?.continuation?.hasArtifact(reference.artifactId)
            ? input.child.continuation.artifactReader.read(reference, maximumBytes, signal)
            : rootContinuation?.hasArtifact(reference.artifactId)
              ? rootContinuation.artifactReader.read(reference, maximumBytes, signal)
              : material!.artifactReader.read(reference, maximumBytes, signal) }, now: () => Number(clock.now()) }),
      eligibility: { evaluate: async (candidate) => {
        const eligible = candidate.platform === 'win32-x64' && candidate.surface === 'coder.interactive'
          && candidate.runtimeBuildId === runtimePackage.manifest.buildId
          && candidate.runtimeBinarySha256 === runtimePackage.binaries.runner.sha256;
        return { eligible, reasons: eligible ? [] : [{ code: 'rust_disabled', dimension: 'product-certification' }] };
      } },
    });
    launched = true;
    renewal.activate(attached.renewAuthority);
    const done = (async (): Promise<PreparedCoderOutcome> => {
      // closed includes the Host drain on success, cancellation and provider
      // failure. The public terminal cannot overtake workspace release.
      await attached.closed;
      const terminal = attached.getTerminal();
      return { reason: terminal && ['max_turns', 'max_tool_calls', 'ipc_identity_budget', 'workspace_transition'].includes(terminal.reasonCode) ? terminal.reasonCode
        : bus.ctrl.signal.aborted || terminal?.classification === journal.EngineTerminalClassificationV1.INTERRUPTED ? 'aborted'
        : terminal?.reasonCode ?? 'completed', usage: attached.getUsage(),
        ...(attached.hasUncertainEffects() ? { effectOutcome: 'unknown' as const } : {}) };
    })().finally(async () => { consumption.close(); hostEffects.abort(); await renewal.close(); clearTimeout(executionTimer); unregisterHistory?.(); effects.seal(); interactions.close(); toolMaterial.close(); await outputStore.close(); rootContinuation?.close(); await continuation?.source.close(); await material?.close();
      input.onWorkspaceBudgetClosed?.({ execution: executionBudget, usage: sharedTree.budget.usage, maxAgents: sharedTree.budget.limits.maxAgents }); });
    void done.catch(() => undefined);
    const resolveInteraction: PreparedCoderExecution['resolveInteraction'] = (id, response) => treeOwner.interactions.owns(id)
      ? treeOwner.interactions.resolve(id, response) : attached.handle.resolveInteraction(id, response);
    return { done, transcriptFlushed: done,
      isWaitingForInput: () => interactions.isWaiting || treeOwner.interactions.isWaiting,
      isInteractionPending: id => interactions.hasPending(id) || treeOwner.interactions.hasPending(id),
      cancel: (reason) => attached.handle.cancel(reason ?? { code: 'user_cancelled' }),
      resolveInteraction,
      provideInput: async (id, value) => {
        await resolveInteraction(id, { value, idempotencyKey: `native-input:${id}:${createHash('sha256').update(value).digest('hex')}` }); return true;
      } };
  } finally {
    if (!launched) {
      consumption.close();
      hostEffects.abort();
      await renewal.close();
      clearTimeout(executionTimer);
      unregisterHistory?.();
      effects.seal();
      await closeOwnedCommands(effects, shell, commands, closeApplications, () => treeOwner.close());
      interactions.close(); toolMaterial.close(); await outputStore.close(); rootContinuation?.close(); await continuation?.source.close(); await material?.close();
      if (!activationStarted) {
        releaseRuntimeResources?.();
        // Pure preparation failed: no native launch or Host invocation exists.
        // Keeping this exclusive lease would permanently block the workspace.
        await leases.release(lease, () => effects.waitForIdle());
      }
      // A failed launch may already have created a process. Keep its lease for
      // recovery; expiry is sufficient to fence read-only authority meanwhile.
    }
  }
}

function normalizeRoot(path: string) { return resolve(path).toLowerCase(); }

async function closeOwnedCommands(effects: HostEffectScope, shell?: NativeShellPort, commands?: NativePersistentCommandPort,
  closeApplications?: () => Promise<void>, closeChildren?: () => Promise<void>) {
  // Every owner receives cancellation, even if another owner rejects cleanup.
  const closed = await Promise.allSettled([
    effects.waitForIdle(AbortSignal.timeout(10_000)), shell?.close(), commands?.close(), closeApplications?.(), closeChildren?.(),
  ]);
  const failed = closed.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failed) throw failed.reason;
}
