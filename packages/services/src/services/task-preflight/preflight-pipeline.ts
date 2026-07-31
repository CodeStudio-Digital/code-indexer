/**
 * TaskPreflightService — one-shot analysis of the FIRST user prompt of a
 * fresh coder session.
 *
 * "Configured" means: a `code-agent/preflight` binding row exists and its
 * provider is enabled (Admin → Pipelines). No binding → `unconfigured` and
 * the session starts exactly as before. Every failure mode is fail-open:
 * this service NEVER throws and never blocks a session.
 */
import {
  type FallbackDefault,
  type PipelineProviderResolver,
} from '../../pipelines/index.js';
import {
  bindingProblem,
  callConfiguredChat,
  friendlyProviderError,
} from '../../quality/binding-chat.js';
import { suppressThinkingFor } from '../../quality/chat-dispatcher.js';
import type { ChatCallResult } from '../../quality/llm-chat.js';
import {
  buildPreflightMessages,
  cleanSessionTitle,
  cleanSessionTitleSeed,
  parsePreflightOutput,
  type PreflightMemoryEntry,
  type PreflightSeed,
  type PreflightSkillMeta,
  type PreflightToolMeta,
  type PreflightWorkspaceProject,
} from './preflight-prompt.js';
import {
  preflightCapabilityFingerprint,
  preparePreflightCatalogs,
} from './preflight-context.js';
import type { SessionId } from '@mcp/session-storage';

const PIPELINE_NAME = 'code-agent';
const ROLE = 'preflight';
const LABEL = `${PIPELINE_NAME}/${ROLE}`;
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MAX_TOOLS = 4;
// Three durable facts are enough to constrain the first move. A five-item seed
// made weaker models eagerly open several overlapping memories before reading
// code, increasing latency and context without improving the implementation.
const MAX_MEMORIES = 3;
const MAX_SKILLS = 3;

export type PreflightStatus = 'ok' | 'unconfigured' | 'timeout' | 'provider_error' | 'parse_fail';

export interface PreflightRunResult {
  status: PreflightStatus;
  seed?: PreflightSeed;
  raw: string;
  latencyMs: number;
  providerId?: string;
  modelId?: string;
  resolvedFrom?: string;
  error?: string;
}

export interface TaskPreflightDeps {
  resolver: PipelineProviderResolver;
  getToolCatalog: () => PreflightToolMeta[];
  getMemoryIndex: (projectId: number) => PreflightMemoryEntry[];
  /** Active skills for the session (id + description + namespace), for task-aware suggestion. */
  getSkillCatalog?: (
    sessionId: SessionId,
    projectId: number,
    projectRoot?: string,
    activeSkillIds?: readonly string[] | null,
  ) => PreflightSkillMeta[];
  /**
   * Zero-config fallback model (the general default) used when no
   * `code-agent/preflight` binding is configured. A configured binding always
   * wins; this removes the silent-dead state where an unset binding meant
   * preflight never ran. Mirrors the run-end memory distiller.
   */
  getFallbackDefault?: () => FallbackDefault | null;
}

export interface TaskPreflightInput {
  sessionId: SessionId;
  projectId?: number | null;
  userMessage: string;
  /** True for a synthetic union even when it currently has one linked member. */
  isGlobalWorkspace?: boolean;
  /** Real project members of the active workspace (one for normal sessions). */
  workspaceProjects?: PreflightWorkspaceProject[];
  /** Explicit per-session filesystem projection; null/undefined uses defaults. */
  activeSkillIds?: readonly string[] | null;
  /** Overrides for tests; defaults come from env (settings panel). */
  timeoutMs?: number;
  maxTools?: number;
  fetchFn?: typeof fetch;
}

export interface SessionTitleInput {
  userMessage: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export interface SessionTitleRunResult {
  status: PreflightStatus;
  title?: string;
  latencyMs: number;
  providerId?: string;
  modelId?: string;
  resolvedFrom?: string;
  error?: string;
}

function envInt(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export class TaskPreflightService {
  constructor(private readonly deps: TaskPreflightDeps) {}

  private resolveBinding() {
    return this.deps.resolver.resolveOrNull(
      PIPELINE_NAME,
      ROLE,
      {},
      this.deps.getFallbackDefault?.() ?? undefined,
    );
  }

  /** Cache fingerprint for project membership + the currently eligible capabilities. */
  getCapabilityFingerprint(input: TaskPreflightInput): string {
    return preflightCapabilityFingerprint(preparePreflightCatalogs(this.deps, input));
  }

  /**
   * Title-only fallback through the same configured preflight binding. The
   * normal path gets a title for free in `run()`; this covers disabled/failed
   * preflight and sessions created before the browser component mounted.
   */
  async generateSessionTitle(input: SessionTitleInput): Promise<SessionTitleRunResult> {
    const startedAt = performance.now();
    const done = (partial: Omit<SessionTitleRunResult, 'latencyMs'>): SessionTitleRunResult => ({
      ...partial,
      latencyMs: Math.round(performance.now() - startedAt),
    });

    try {
      const binding = await this.resolveBinding();
      if (!binding) return done({ status: 'unconfigured' });
      const ids = { providerId: binding.provider.id, modelId: binding.modelId };
      const problem = bindingProblem(binding, { label: `${LABEL} session title`, codePrefix: 'session_title' });
      if (problem) return done({ status: 'provider_error', ...ids, error: problem.message });

      const userMessage = cleanSessionTitleSeed(input.userMessage);
      if (!userMessage) return done({ status: 'parse_fail', ...ids, error: 'empty title seed' });
      const timeoutMs = input.timeoutMs ?? envInt('CODER_PREFLIGHT_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
      const result = await callConfiguredChat(binding, [
        {
          role: 'system',
          content: 'Generate a concise 3-7 word chat session title. Return only the title, with no quotes, markdown, or trailing punctuation.',
        },
        { role: 'user', content: userMessage },
      ], {
        temperature: 0,
        maxTokens: 48,
        timeoutMs,
        disableThinking: suppressThinkingFor(binding),
        reasoningEffort: 'minimal',
        fetchFn: input.fetchFn,
      });
      if (result.errorBody) {
        const status = result.finishReason === 'timeout' ? 'timeout' : 'provider_error';
        return done({
          status,
          ...ids,
          error: friendlyProviderError(binding, result.errorBody, `${LABEL} session title`),
        });
      }
      const title = cleanSessionTitle(result.content);
      if (!title) return done({ status: 'parse_fail', ...ids, error: 'empty title generated' });
      return done({ status: 'ok', title, ...ids, resolvedFrom: binding.resolvedFrom });
    } catch (error) {
      return done({
        status: 'provider_error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async run(input: TaskPreflightInput): Promise<PreflightRunResult> {
    const startedAt = performance.now();
    const done = (partial: Omit<PreflightRunResult, 'latencyMs' | 'raw'> & { raw?: string }): PreflightRunResult => ({
      raw: '',
      ...partial,
      latencyMs: Math.round(performance.now() - startedAt),
    });

    try {
      // Resolve GLOBALLY (no sessionId scope) — preflight is a pre-session
      // analysis, not a session-bound call. A configured `code-agent/preflight`
      // binding wins; otherwise fall back to the general default model so
      // preflight runs zero-config.
      const binding = await this.resolveBinding();
      if (!binding) return done({ status: 'unconfigured' });

      const ids = { providerId: binding.provider.id, modelId: binding.modelId };
      const problem = bindingProblem(binding, { label: LABEL, codePrefix: 'preflight' });
      if (problem) return done({ status: 'provider_error', ...ids, error: problem.message });

      const { toolCatalog, memoryIndex, skillCatalog, workspaceProjects } =
        preparePreflightCatalogs(this.deps, input);
      const maxTools = input.maxTools ?? envInt('CODER_PREFLIGHT_MAX_TOOLS', DEFAULT_MAX_TOOLS);
      const timeoutMs = input.timeoutMs ?? envInt('CODER_PREFLIGHT_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
      const messages = buildPreflightMessages({
        userMessage: input.userMessage,
        toolCatalog,
        memoryIndex,
        skillCatalog,
        workspaceProjects: input.isGlobalWorkspace ? workspaceProjects : undefined,
        maxTools,
        maxMemories: MAX_MEMORIES,
        maxSkills: MAX_SKILLS,
      });

      const cfg = binding.config as Record<string, unknown>;
      // Abort on timeout: both the direct REST path and the chatgpt/codex OAuth
      // adapter honor an AbortSignal, so a slow model never leaks a background
      // request after we give up.
      const controller = new AbortController();
      const call = callConfiguredChat(binding, messages, {
        temperature: 0,
        maxTokens: typeof cfg.max_tokens === 'number' ? cfg.max_tokens : 700,
        timeoutMs,
        // One-shot SELECTION task (pick tools/skills/profile): minimize reasoning
        // so a reasoning model answers in ~1-2s instead of blowing the budget.
        // disableThinking is gated per provider (strict OpenAI-family rejects
        // unknown body params) and covers GLM/Gemini; reasoningEffort 'minimal'
        // is the lever for the Codex/OAuth path (e.g. gpt-5.x), clamped upstream.
        disableThinking: suppressThinkingFor(binding),
        reasoningEffort: 'minimal',
        signal: controller.signal,
        fetchFn: input.fetchFn,
      });

      // Backstop timer in case the provider ignores the abort: resolve the race
      // at the deadline, abort the call (cancel the underlying request) and fail
      // open. The session then starts unseeded — never blocked.
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      const timeoutSentinel = Symbol('preflight-timeout');
      const raced = await Promise.race([
        call,
        new Promise<typeof timeoutSentinel>((resolve) => {
          timer = setTimeout(() => { timedOut = true; resolve(timeoutSentinel); }, timeoutMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
      // `timedOut` also catches the tight race where the timeout aborts the call
      // and the aborted call resolves with `{errorBody:'…aborted'}` first — that
      // must report `timeout`, not `provider_error`.
      if (raced === timeoutSentinel || timedOut) {
        controller.abort();
        void call.catch(() => undefined); // abandoned; never unhandled
        return done({ status: 'timeout', ...ids, error: `preflight timed out after ${timeoutMs}ms` });
      }

      const result = raced as ChatCallResult;
      if (result.errorBody) {
        return done({
          status: 'provider_error',
          ...ids,
          raw: result.content,
          error: friendlyProviderError(binding, result.errorBody, LABEL),
        });
      }

      const seed = parsePreflightOutput(result.content, {
        toolNames: new Set(toolCatalog.map((t) => t.name)),
        memoryTitles: memoryIndex.map((m) => m.title),
        memoryEntries: memoryIndex,
        skillIds: new Set(skillCatalog.map((s) => s.id)),
        skillMetaById: new Map(skillCatalog.map((s) => [s.id, {
          evidence: s.evidence,
          projectSlugs: s.projectSlugs,
        }])),
        projectSlugs: new Set(input.isGlobalWorkspace ? workspaceProjects.map((p) => p.slug) : []),
        maxTools,
        maxMemories: MAX_MEMORIES,
        maxSkills: MAX_SKILLS,
      });
      if (!seed) return done({ status: 'parse_fail', ...ids, raw: result.content });

      return done({
        status: 'ok',
        seed,
        ...ids,
        raw: result.content,
        resolvedFrom: binding.resolvedFrom,
      });
    } catch (e) {
      return done({
        status: 'provider_error',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}
