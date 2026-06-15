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
  type PipelineProviderResolver,
} from '../../pipelines/index.js';
import {
  bindingProblem,
  callConfiguredChat,
  friendlyProviderError,
} from '../../quality/binding-chat.js';
import type { ChatCallResult } from '../../quality/llm-chat.js';
import {
  buildPreflightMessages,
  parsePreflightOutput,
  type PreflightMemoryEntry,
  type PreflightSeed,
  type PreflightToolMeta,
} from './preflight-prompt.js';

const PIPELINE_NAME = 'code-agent';
const ROLE = 'preflight';
const LABEL = `${PIPELINE_NAME}/${ROLE}`;
const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_MAX_TOOLS = 12;
const MAX_MEMORIES = 5;

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
}

export interface TaskPreflightInput {
  sessionId: number;
  projectId?: number | null;
  userMessage: string;
  /** Overrides for tests; defaults come from env (settings panel). */
  timeoutMs?: number;
  maxTools?: number;
  fetchFn?: typeof fetch;
}

function envInt(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export class TaskPreflightService {
  constructor(private readonly deps: TaskPreflightDeps) {}

  async run(input: TaskPreflightInput): Promise<PreflightRunResult> {
    const startedAt = performance.now();
    const done = (partial: Omit<PreflightRunResult, 'latencyMs' | 'raw'> & { raw?: string }): PreflightRunResult => ({
      raw: '',
      ...partial,
      latencyMs: Math.round(performance.now() - startedAt),
    });

    try {
      const binding = await this.deps.resolver.resolveOrNull(PIPELINE_NAME, ROLE, {
        sessionId: input.sessionId,
      });
      if (!binding) return done({ status: 'unconfigured' });

      const ids = { providerId: binding.provider.id, modelId: binding.modelId };
      const problem = bindingProblem(binding, { label: LABEL, codePrefix: 'preflight' });
      if (problem) return done({ status: 'provider_error', ...ids, error: problem.message });

      const toolCatalog = this.deps.getToolCatalog();
      const memoryIndex = input.projectId != null ? this.deps.getMemoryIndex(input.projectId) : [];
      const maxTools = input.maxTools ?? envInt('CODER_PREFLIGHT_MAX_TOOLS', DEFAULT_MAX_TOOLS);
      const timeoutMs = input.timeoutMs ?? envInt('CODER_PREFLIGHT_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
      const messages = buildPreflightMessages({
        userMessage: input.userMessage,
        toolCatalog,
        memoryIndex,
        maxTools,
        maxMemories: MAX_MEMORIES,
      });

      const cfg = binding.config as Record<string, unknown>;
      const call = callConfiguredChat(binding, messages, {
        temperature: 0,
        maxTokens: typeof cfg.max_tokens === 'number' ? cfg.max_tokens : 700,
        timeoutMs,
        fetchFn: input.fetchFn,
      });

      // Global backstop: the OAuth coder-client path has no AbortController,
      // so race the call against a timer (+ small grace over the HTTP timeout).
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutSentinel = Symbol('preflight-timeout');
      const raced = await Promise.race([
        call,
        new Promise<typeof timeoutSentinel>((resolve) => {
          timer = setTimeout(() => resolve(timeoutSentinel), timeoutMs + 250);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (raced === timeoutSentinel) {
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
        maxTools,
        maxMemories: MAX_MEMORIES,
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
