/** Inline AI completion: suitability-gated routing, latest-wins execution,
 * versioned context/cache, circuit breaking, validation and lifecycle metrics. */
import { randomUUID } from 'node:crypto';
import type {
  EditorApi,
  EditorCompleteInput,
  EditorCompleteResult,
  EditorCompletionRoute,
} from '@mcp/api-bus';
import type { ResolvedBinding } from '@mcp/services/pipelines/provider-resolver.js';
import {
  bindingProblem,
  callConfiguredChat,
  CODER_CHAT_KINDS,
  friendlyProviderError,
} from '@mcp/services/quality/binding-chat.js';
import {
  completionBindingRevision,
  completionCompatibility,
} from '@mcp/services/quality/completion-compatibility.js';
import { supportsFim, fimCompletion, markFimUnsupported } from '@mcp/services/quality/fim-completion.js';
import type { ChatCallResult } from '@mcp/services/quality/llm-chat.js';
import { extractGateFeatures, GATE_FEATURE_VERSION } from '@mcp/shared/editor/completion-prefilter.js';
import { durationToBucket } from '@mcp/store/pipeline-telemetry-store.js';
import type { HandlerDeps } from '../types.js';
import { getDoc } from '../lsp/document-store.js';
import { TtlLru } from './completion-context.js';
import { buildLayeredContext } from './completion/context.js';
import { parseCompletionCfg } from './completion/config.js';
import { assembleContext, renderSnippetSections } from './completion/snippets/engine.js';
import { contextRevision } from './completion/snippets/edit-tracker.js';
import { resolveLatencyPolicy, adaptiveDebounce, noteOkLatency, resolveGenParams } from './completion/policy.js';
import { forwardMatch, rememberCompletion } from './completion/forward-cache.js';
import { computeEditorStats } from './stats.js';
import { decideMultiline } from './completion/multiline.js';
import { postProcessV2 } from './completion/postprocess.js';
import { LatestWinsCoordinator } from './completion/latest-wins.js';
import {
  noteCircuitFailure,
  noteCircuitSuccess,
  selectCircuitBinding,
} from './completion/circuit.js';
import { offsetAt, validateCompletion } from './completion/validate.js';
import { completionResultCacheKey } from './completion/cache-key.js';
import { runCompletionProbe } from './completion/probe.js';
import { buildCompletionMessages, stopSequencesFor, trimWindows } from './completion-prompt.js';
import { resolveEditorConfig } from './editorconfig.js';

type EditorDeps = Pick<HandlerDeps, 'db' | 'pipelineProviderResolver' | 'pipelineTelemetryStore'>
  & Partial<Pick<HandlerDeps, 'pipelineBindingsStore'>>;

const PIPELINE = 'editor';
const ROLE = 'autocomplete';
const LABEL = `${PIPELINE}/${ROLE}`;

interface RequestCorrelation {
  model: string;
  bindingId: number | null;
  latencyMs: number;
  diag: Record<string, unknown>;
  sent?: Record<string, true>;
  feedbackOk: boolean;
  terminal?: 'accept' | 'reject';
  pendingReject?: ReturnType<typeof setTimeout>;
}

const resultCache = new TtlLru<{ text: string; requestId: string; route: EditorCompletionRoute }>(96, 45_000);
const requests = new TtlLru<RequestCorrelation>(256, 300_000);
const coordinator = new LatestWinsCoordinator<EditorCompleteResult>();
let feedbackTelemetryEnabled = true;

/** Test-only lifecycle seed/reset: exercises server correlation without a provider call. */
export function __seedCompletionRequestForTests(requestId: string): void {
  requests.set(requestId, {
    model: 'test-model', bindingId: 1, latencyMs: 10,
    diag: { status: 'ok', bindingId: 1 }, feedbackOk: true,
  });
}

export function __resetCompletionRequestsForTests(): void {
  requests.clear();
}

const FEEDBACK_STAGES: Record<string, string> = {
  shown: 'autocomplete_shown', accept: 'autocomplete_accept', partial: 'autocomplete_partial',
  reject: 'autocomplete_reject', prefilter_skip: 'autocomplete_prefilter',
};

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}

function shouldDisableThinking(kind: string, modelId: string): boolean {
  return kind === 'zai' || /glm|qwen3|deepseek-r1/i.test(modelId)
    || (kind === 'gemini' && /gemini-[2-9]/i.test(modelId));
}

function windowHash(prefix: string, suffix: string): string {
  let h = 5381;
  const s = `${prefix}\0${suffix}`;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function safeRoute(
  binding: ResolvedBinding,
  health: EditorCompletionRoute['health'],
  reason?: string,
): EditorCompletionRoute {
  const compatibility = completionCompatibility(binding);
  return {
    bindingId: binding.bindingId,
    providerId: binding.provider.id,
    provider: binding.provider.name || binding.provider.id,
    model: binding.modelId,
    transport: compatibility.transport,
    suitability: compatibility.suitability,
    health,
    ...(reason || compatibility.reason ? { reason: reason ?? compatibility.reason } : {}),
  };
}

function knownMemberNames(rendered: string): string[] {
  const out: string[] = [];
  for (const line of rendered.split('\n').slice(1)) {
    const match = line.trim().match(/^[$A-Za-z_][\w$]*/);
    if (match) out.push(match[0]!);
  }
  return out;
}

export function createEditorHandlers(deps: EditorDeps): EditorApi {
  const record = (stage: string, durationMs: number, model: string, opts: {
    errors?: number; cacheHit?: boolean; diag?: Record<string, unknown>;
  } = {}) => {
    try {
      deps.pipelineTelemetryStore.insert({
        pipeline_name: PIPELINE, stage, component_name: model,
        duration_ms: Math.round(durationMs), duration_bucket: durationToBucket(durationMs),
        cache_hits: opts.cacheHit ? 1 : 0, cache_misses: opts.cacheHit === false ? 1 : 0,
        errors: opts.errors ?? 0, diag: opts.diag ?? null,
      });
    } catch { /* telemetry is fail-open */ }
  };

  const resolveRoute = async (input: EditorCompleteInput): Promise<{
    binding: ResolvedBinding; route: EditorCompletionRoute;
  } | { result: EditorCompleteResult }> => {
    let chain: ResolvedBinding[];
    try {
      const resolver = deps.pipelineProviderResolver as typeof deps.pipelineProviderResolver & {
        resolveChain?: typeof deps.pipelineProviderResolver.resolveChain;
      };
      if (typeof resolver.resolveChain === 'function') chain = await resolver.resolveChain(PIPELINE, ROLE, {});
      else {
        const one = await resolver.resolveOrNull(PIPELINE, ROLE, {});
        chain = one ? [one] : [];
      }
    }
    catch { return { result: { status: 'unconfigured' } }; }
    if (!chain.length) return { result: { status: 'unconfigured' } };

    // Automatic requests skip manual-only chat links and open circuits. An
    // explicit Alt+\ request may use a slow/manual model, but still respects
    // hard auth/rate-limit circuits.
    const eligible = input.trigger === 'explicit'
      ? chain
      : chain.filter((binding) => completionCompatibility(binding).automatic);
    if (!eligible.length) {
      const route = safeRoute(chain[0]!, 'degraded');
      return { result: { status: 'manual_only', route, message: route.reason } };
    }
    const selected = selectCircuitBinding(eligible, input.projectId);
    if (!selected) {
      const route = safeRoute(eligible[0]!, 'circuit-open', 'Every configured completion binding is cooling down.');
      return { result: { status: 'provider_error', route, message: route.reason, retryAfterMs: 5_000 } };
    }
    const problem = bindingProblem(selected.binding, { label: LABEL, codePrefix: 'autocomplete' });
    if (problem) {
      const route = safeRoute(selected.binding, 'degraded', problem.message);
      return { result: { status: 'provider_error', route, message: problem.message, retryAfterMs: 300_000 } };
    }
    return { binding: selected.binding, route: safeRoute(selected.binding, selected.health, selected.reason) };
  };

  const executeCompletion = async (
    input: EditorCompleteInput,
    binding: ResolvedBinding,
    baseRoute: EditorCompletionRoute,
    signal: AbortSignal,
  ): Promise<EditorCompleteResult> => {
    const startedAt = performance.now();
    const cfg = binding.config as Record<string, unknown>;
    const model = binding.modelId;
    const bindingRevision = completionBindingRevision(binding);
    const useFim = supportsFim(binding);
    const routeForCall: EditorCompletionRoute = {
      ...baseRoute,
      transport: useFim ? baseRoute.transport : CODER_CHAT_KINDS.has(binding.provider.kind) ? 'oauth-chat' : 'chat',
    };
    const rc = parseCompletionCfg(cfg, useFim ? 'fim' : 'chat');
    const policy = resolveLatencyPolicy(cfg);
    const bindingKey = `${binding.provider.id}:${model}`;
    const debounceMs = adaptiveDebounce(bindingKey, policy);
    const suppression = policy.suppression;
    const feedbackOk = cfg.feedback_telemetry !== false;
    feedbackTelemetryEnabled = feedbackOk;
    const windows = trimWindows(input.prefix, input.suffix, rc.maxPrefixLines, rc.maxSuffixLines);
    const multiline = decideMultiline(rc.multilineMode, windows.prefix, windows.suffix, input.language);
    const position = input.position ?? { line: 1, col: 1 };
    const cursorLine = position.line;
    const revision = contextRevision(input.projectId);
    const documentVersion = input.documentVersion ?? 0;

    const fwd = forwardMatch(input.projectId, input.file, cursorLine, windows.prefix, bindingRevision);
    if (fwd) {
      record('autocomplete', performance.now() - startedAt, model, {
        cacheHit: true, diag: { status: 'ok', served: 'forward', bindingId: binding.bindingId },
      });
      return { status: 'ok', text: fwd.text, debounceMs, requestId: fwd.requestId, suppression, served: 'forward', route: { ...routeForCall, health: 'healthy' } };
    }
    const cacheKey = completionResultCacheKey({
      bindingRevision, projectId: input.projectId, file: input.file, language: input.language,
      cursorLine, documentVersion, contextRevision: revision, contextEngine: rc.contextEngine,
      windowHash: windowHash(windows.prefix, windows.suffix),
    });
    const cached = resultCache.get(cacheKey);
    if (cached) {
      record('autocomplete', performance.now() - startedAt, model, {
        cacheHit: true, diag: { status: 'ok', served: 'cache', bindingId: binding.bindingId },
      });
      return { status: 'ok', text: cached.text, debounceMs, requestId: cached.requestId, suppression, served: 'cache', route: cached.route };
    }

    const contextStarted = performance.now();
    let contextStable = '';
    let contextVolatile = '';
    let ctxDiag: Record<string, unknown>;
    let fimSnippets: Array<{ filePath: string; content: string }> | undefined;
    let fimVolatile: string | undefined;
    let repoName = 'repo';
    let memberNames: string[] = [];
    let memberTriggered = false;
    const useV1 = rc.contextEngine === 'v1' || rc.contextMode === 'imports_only';
    if (useV1) {
      const ctx = await buildLayeredContext({
        db: deps.db, projectId: input.projectId, file: input.file, language: input.language,
        windows, position, budgetChars: num(cfg.context_budget_chars, 2500), mode: rc.contextMode,
      });
      contextVolatile = ctx.block;
      memberTriggered = ctx.memberTriggerHit;
      ctxDiag = {
        engine: 'v1', contextMode: rc.contextMode, memberSource: ctx.memberSource,
        memberTriggerHit: ctx.memberTriggerHit, membersInjected: ctx.membersInjected,
        contextChars: ctx.chars, tiers: ctx.tiersUsed,
      };
    } else {
      const ctx2 = await assembleContext({
        db: deps.db, projectId: input.projectId, file: input.file, language: input.language,
        windows, position, budgetTokens: rc.budgetTokens, sourceTimeoutMs: rc.sourceTimeoutMs,
        deadlineMs: rc.deadlineMs, cacheTtlMs: rc.contextEngine === 'v3' ? Math.min(rc.cacheTtlMs, 1_500) : rc.cacheTtlMs,
        lspMemberRaceMs: rc.lspMemberRaceMs,
        toggles: { ...rc.toggles, relatedCode: rc.contextEngine === 'v3' && rc.toggles.relatedCode },
        relatedCodeTokens: rc.relatedCodeTokens, jaccardMinScore: rc.jaccardMinScore, maxTabFiles: rc.maxTabFiles,
      });
      contextStable = renderSnippetSections(ctx2.stable);
      contextVolatile = renderSnippetSections(ctx2.volatile);
      memberTriggered = ctx2.memberTriggerHit;
      memberNames = knownMemberNames(ctx2.volatile.find((s) => s.kind === 'members')?.content ?? '');
      const fileKinds = new Set(['recent-edit', 'lsp-def', 'open-tab', 'related-code']);
      fimSnippets = ctx2.stable.filter((s) => fileKinds.has(s.kind)).map((s) => ({ filePath: s.filePath, content: s.content }));
      fimVolatile = renderSnippetSections([
        ...ctx2.stable.filter((s) => s.kind === 'siblings' || s.kind === 'imports'), ...ctx2.volatile,
      ]);
      try {
        const root = deps.db.getProject(input.projectId)?.root_path ?? '';
        repoName = root.split(/[\\/]/).filter(Boolean).pop() ?? 'repo';
      } catch { /* default */ }
      ctxDiag = {
        engine: rc.contextEngine, contextMode: rc.contextMode, memberSource: ctx2.memberSource,
        memberTriggerHit: ctx2.memberTriggerHit, membersInjected: ctx2.membersInjected,
        inferSource: ctx2.inferSource, contextChars: contextStable.length + contextVolatile.length,
        contextTokens: ctx2.totalTokens, stableHit: ctx2.stableCacheHit,
        tiers: [...ctx2.stable, ...ctx2.volatile].map((s) => s.kind), src: ctx2.sources,
      };
    }
    const contextMs = performance.now() - contextStarted;
    record('autocomplete_context', contextMs, model, { diag: { bindingId: binding.bindingId, ...ctxDiag } });
    if (signal.aborted) return { status: 'empty', debounceMs, suppression, route: routeForCall };

    const contextCombined = [contextStable, contextVolatile].filter(Boolean).join('\n\n');
    const messages = buildCompletionMessages({
      language: input.language, file: input.file, windows,
      contextStable: contextStable || undefined, contextVolatile: contextVolatile || undefined,
    });
    const gen = resolveGenParams(cfg, useFim ? 'fim' : 'chat', multiline);
    const callOpts = {
      temperature: gen.temperature, maxTokens: gen.maxTokens, timeoutMs: rc.timeoutMs,
      stop: stopSequencesFor(multiline), signal,
      disableThinking: rc.disableThinkingOverride === false ? false : shouldDisableThinking(binding.provider.kind, model),
      reasoningEffort: 'minimal',
    };
    const generationStarted = performance.now();
    const result: ChatCallResult = useFim
      ? await fimCompletion(binding, {
          prefix: windows.prefix, suffix: windows.suffix, context: contextCombined, language: input.language,
          snippets: fimSnippets, volatileBlock: fimVolatile, filePath: input.file, repoName,
        }, callOpts)
      : await callConfiguredChat(binding, messages, callOpts);
    const generationMs = performance.now() - generationStarted;
    record('autocomplete_generation', generationMs, model, {
      errors: result.errorBody ? 1 : 0,
      diag: { bindingId: binding.bindingId, endpoint: useFim ? 'fim' : 'chat', finishReason: result.finishReason ?? 'provider' },
    });
    record('autocomplete_ttft', result.ttftMs ?? result.latencyMs, model, {
      diag: { bindingId: binding.bindingId, measured: result.ttftMs !== undefined },
    });
    if (signal.aborted && result.finishReason !== 'local_stop' && result.finishReason !== 'local_max_tokens') {
      record('autocomplete', performance.now() - startedAt, model, { diag: { status: 'superseded', bindingId: binding.bindingId } });
      return { status: 'empty', debounceMs, suppression, route: routeForCall };
    }
    if (result.errorBody) {
      if (useFim && (result.status === 400 || result.status === 404)) markFimUnsupported(binding);
      const circuit = noteCircuitFailure(binding, input.projectId, result, rc.timeoutMs);
      const route = { ...safeRoute(binding, circuit.health, circuit.reason), transport: routeForCall.transport };
      const timedOut = result.finishReason === 'timeout' || (!result.status && /abort|timeout/i.test(result.errorBody));
      const status = timedOut ? 'timeout' : 'provider_error';
      record('autocomplete', performance.now() - startedAt, model, {
        errors: 1, diag: { status, http: result.status ?? null, bindingId: binding.bindingId },
      });
      return {
        status, debounceMs, suppression, route,
        message: timedOut ? `${model} exceeded the ${Math.round(rc.timeoutMs / 100) / 10}s completion timeout.`
          : friendlyProviderError(binding, result.errorBody, LABEL),
        retryAfterMs: result.retryAfterMs,
      };
    }

    const postStarted = performance.now();
    const text = postProcessV2(result.content, { prefix: windows.prefix, suffix: windows.suffix, multiline });
    if (!text) {
      const emptyStatus = result.content.length === 0 ? 'empty-model' : 'empty-filtered';
      record('autocomplete_postprocess', performance.now() - postStarted, model, { diag: { status: emptyStatus } });
      record('autocomplete', performance.now() - startedAt, model, {
        cacheHit: false, diag: { status: emptyStatus, rawChars: result.content.length, bindingId: binding.bindingId, ...ctxDiag },
      });
      return { status: 'empty', debounceMs, suppression, route: routeForCall };
    }

    const doc = getDoc(input.projectId, input.file);
    const original = doc?.content ?? `${windows.prefix}${windows.suffix}`;
    const offset = doc ? offsetAt(original, position.line, position.col) : windows.prefix.length;
    const validation = await validateCompletion({
      file: input.file, original, candidate: text, offset, prefix: windows.prefix, suffix: windows.suffix,
      knownMembers: memberNames, memberTriggered,
    });
    const validatedText = validation.ok ? (validation.candidate ?? text) : text;
    const postMs = performance.now() - postStarted;
    record('autocomplete_postprocess', postMs, model, {
      diag: {
        status: validation.ok ? 'ok' : 'empty-filtered',
        filterReason: validation.ok ? null : validation.reason,
        salvaged: validation.ok && validation.salvaged === true,
      },
    });
    if (!validation.ok) {
      record('autocomplete', performance.now() - startedAt, model, {
        cacheHit: false, diag: { status: 'empty-filtered', filterReason: validation.reason, bindingId: binding.bindingId, ...ctxDiag },
      });
      return { status: 'empty', debounceMs, suppression, route: routeForCall };
    }

    noteCircuitSuccess(binding, input.projectId);
    noteOkLatency(bindingKey, result.latencyMs);
    const requestId = randomUUID();
    const route = { ...safeRoute(binding, 'healthy'), transport: routeForCall.transport };
    // Related-code state changes independently; keep its result cache short.
    const ttl = rc.contextEngine === 'v3' && rc.toggles.relatedCode ? Math.min(policy.cacheTtlMs, 1_500) : policy.cacheTtlMs;
    resultCache.set(cacheKey, { text: validatedText, requestId, route }, ttl);
    rememberCompletion(input.projectId, input.file, cursorLine, windows.prefix, validatedText, requestId, bindingRevision);
    const latencyMs = performance.now() - startedAt;
    // Gate-feature capture for the learned completion gate (R7): the trainer
    // joins these request-side features with the shown/accept/reject feedback
    // rows by requestId. Same extractor the client gates with — one contract.
    const prefixNl = windows.prefix.lastIndexOf('\n');
    const suffixNl = windows.suffix.indexOf('\n');
    const gateF = extractGateFeatures({
      lineBefore: windows.prefix.slice(prefixNl + 1),
      lineAfter: suffixNl === -1 ? windows.suffix : windows.suffix.slice(0, suffixNl),
      languageId: input.language,
      prefixTotalTrimmedLen: windows.prefix.trim().length,
    }).map((v) => Math.round(v * 1000) / 1000);
    const okDiag = {
      status: 'ok', bindingId: binding.bindingId, providerId: binding.provider.id,
      language: input.language, chars: validatedText.length, rawChars: result.content.length,
      endpoint: useFim ? 'fim' : 'chat', served: 'model', multiline, debounceMs,
      gateF, gateV: GATE_FEATURE_VERSION,
      contextMs: Math.round(contextMs), generationMs: Math.round(generationMs),
      ttftMs: Math.round(result.ttftMs ?? result.latencyMs), postprocessMs: Math.round(postMs), ...ctxDiag,
    };
    requests.set(requestId, { model, bindingId: binding.bindingId, latencyMs, diag: okDiag, feedbackOk });
    record('autocomplete', latencyMs, model, { cacheHit: false, diag: okDiag });
    return { status: 'ok', text: validatedText, debounceMs, requestId, suppression, served: 'model', route };
  };

  const complete = async (input: EditorCompleteInput): Promise<EditorCompleteResult> => {
    if (!Number.isFinite(input?.projectId) || !input?.file || (!input.prefix && !input.suffix)) return { status: 'empty' };
    const routed = await resolveRoute(input);
    if ('result' in routed) return routed.result;
    const clientRequestId = input.clientRequestId || randomUUID();
    const request = {
      clientRequestId, documentVersion: input.documentVersion ?? 0,
      prefix: input.prefix, suffix: input.suffix,
      routeRevision: completionBindingRevision(routed.binding),
    };
    const queueStarted = performance.now();
    try {
      const coordinated = await coordinator.run(
        `${input.projectId}:${input.file}`,
        request,
        (signal) => executeCompletion(input, routed.binding, routed.route, signal),
      );
      record('autocomplete_queue', performance.now() - queueStarted, routed.binding.modelId, {
        diag: { coalesced: coordinated.coalesced, superseded: coordinated.superseded, bindingId: routed.binding.bindingId },
      });
      if (coordinated.superseded || !coordinated.value) return { status: 'empty', route: routed.route };
      if (coordinated.typedThrough && coordinated.value.status === 'ok' && coordinated.value.text) {
        if (!coordinated.value.text.startsWith(coordinated.typedThrough)) return { status: 'empty', route: coordinated.value.route };
        return { ...coordinated.value, text: coordinated.value.text.slice(coordinated.typedThrough.length) };
      }
      return coordinated.value;
    } catch (e) {
      if (/abort|superseded|cancel/i.test(e instanceof Error ? e.message : String(e))) return { status: 'empty', route: routed.route };
      return { status: 'provider_error', message: e instanceof Error ? e.message : String(e), route: routed.route };
    }
  };

  const recordFeedback = (stage: string, input: Parameters<EditorApi['feedback']>[0], req?: RequestCorrelation) => {
    record(stage, req?.latencyMs ?? 0, req?.model ?? 'unknown', {
      diag: {
        requestId: input?.requestId ?? null, bindingId: req?.bindingId ?? null,
        ...(input?.acceptedChars !== undefined ? { acceptedChars: input.acceptedChars } : {}),
        ...(input?.shownForMs !== undefined ? { shownForMs: input.shownForMs } : {}),
        ...(input?.partialKind ? { partialKind: input.partialKind } : {}), ...(req?.diag ?? {}),
      },
    });
  };

  const recordDelivery = (input: Parameters<EditorApi['delivery']>[0]) => {
    const req = input?.requestId ? requests.get(input.requestId) : undefined;
    record(`autocomplete_client_${input.stage}`, 0, req?.model ?? 'client', {
      diag: {
        requestId: input.requestId ?? null,
        clientRequestId: input.clientRequestId,
        bindingId: req?.bindingId ?? null,
        documentVersion: input.documentVersion ?? null,
        ...(input.reason ? { reason: input.reason } : {}),
      },
    });
  };

  return {
    resolveConfig: async ({ projectId, file }) => {
      const project = deps.db.getProject(projectId);
      if (!project) throw new Error('project not found');
      return resolveEditorConfig(project.root_path, file);
    },
    complete: (input) => complete(input),
    cancel: async (input) => ({ ok: !!input?.clientRequestId && coordinator.cancel(input.clientRequestId) }),
    probe: (input) => runCompletionProbe(deps, input),
    feedback: async (input) => {
      try {
        const action = input?.action ?? 'accept';
        const stage = FEEDBACK_STAGES[action];
        if (!stage) return { ok: false };
        let req = input?.requestId ? requests.get(input.requestId) : undefined;
        if (!req && input?.requestId) {
          req = { model: 'unknown', bindingId: null, latencyMs: 0, diag: {}, feedbackOk: feedbackTelemetryEnabled };
          requests.set(input.requestId, req);
        }
        const allowed = req ? req.feedbackOk : feedbackTelemetryEnabled;
        if (!allowed && action !== 'accept') return { ok: true };
        if (action === 'prefilter_skip') {
          record(stage, 0, 'client', { diag: { detail: input?.detail ?? '' } });
          return { ok: true };
        }
        if (req) {
          req.sent ??= {};
          if (action === 'accept') {
            if (req.terminal === 'accept') return { ok: true };
            if (req.pendingReject) clearTimeout(req.pendingReject);
            req.pendingReject = undefined;
            if (req.terminal !== 'reject') {
              req.terminal = 'accept'; req.sent.accept = true; recordFeedback(stage, input, req);
            }
            return { ok: true };
          }
          if (action === 'reject') {
            if (req.terminal || req.pendingReject) return { ok: true };
            req.pendingReject = setTimeout(() => {
              req.pendingReject = undefined;
              if (!req.terminal) { req.terminal = 'reject'; req.sent!.reject = true; recordFeedback(stage, input, req); }
            }, 500);
            return { ok: true };
          }
          if (req.sent[action]) return { ok: true };
          req.sent[action] = true;
        }
        recordFeedback(stage, input, req);
        return { ok: true };
      } catch { return { ok: false }; }
    },
    delivery: async (input) => {
      try {
        if (!input?.clientRequestId || !['received', 'returned', 'discarded'].includes(input.stage)) return { ok: false };
        if (input.stage === 'discarded' && input.reason
          && !['cancelled', 'version_changed', 'prefix_diverged', 'empty_after_trim'].includes(input.reason)) return { ok: false };
        recordDelivery(input);
        return { ok: true };
      } catch { return { ok: false }; }
    },
    stats: (input) => computeEditorStats(deps, input?.days ?? 7),
  };
}
