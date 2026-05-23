/**
 * QualityWatchdog — a lightweight, always-on LLM watchdog focused on
 * tool-loop / stuck-progress detection.
 *
 * Different from {@link QualityClassifierPipeline} (the 5-classifier
 * pipeline gated by `MCP_PIPELINES_QUALITY_CLASSIFIERS=1`):
 *
 *   - **Single focus**: only detects tool loops / stuck progress.
 *     The other 4 classifiers (off_topic, completeness, code_quality,
 *     policy) stay in their pipeline.
 *   - **Cheap model**: uses its own provider/model — typically a fast
 *     cheap one like `claude-haiku-4-5` or `gemini-2.5-flash`. The
 *     5-classifier pipeline can keep using the main model.
 *   - **Trigger-gated**: doesn't run every turn. The runner consults a
 *     cheap heuristic pre-filter first (`shouldRun()`) and only invokes
 *     the LLM when the pre-filter says "this looks suspicious". Result:
 *     ~5 calls in a 50-turn loop vs. 250 for the full pipeline.
 *   - **On by default** (when provider+model are configured): no need
 *     to flip `MCP_PIPELINES_QUALITY_CLASSIFIERS=1`. The operator opts
 *     out via `MCP_QUALITY_WATCHDOG_ENABLED=0`.
 *
 * Persists each invocation in `quality_classifications` with
 * `classifier_name='tool_loop'` so it doesn't collide with the
 * `tool_misuse` rows the full pipeline writes.
 *
 * Plumbing-agnostic: the constructor takes a single `runChat` function
 * that the caller binds to the actual provider/model. The boot-side
 * server.ts wiring picks `pickChatFn` from the dispatcher and resolves
 * the binding once at process startup. Keeps the watchdog itself free
 * of binding-resolver knowledge and easy to unit-test (just stub
 * `runChat`).
 */
import type { ClassificationVerdict, QualityVerdict } from './types.js';

/**
 * Chat invocation contract — returns the model's reply text. The
 * caller is responsible for selecting the provider/model and handling
 * authentication. Errors bubble; the watchdog catches them.
 */
export type WatchdogChatRunner = (input: {
  system: string;
  user: string;
  maxOutputTokens?: number;
}) => Promise<{ text: string }>;

export interface QualityWatchdogConfig {
  /** Provider id (e.g. 'anthropic'). Stored for telemetry only. */
  provider: string;
  /** Model id (e.g. 'claude-haiku-4-5'). Stored for telemetry only. */
  model: string;
  /** Bound chat runner — the caller pre-resolved the binding. */
  runChat: WatchdogChatRunner;
  /**
   * Heuristic pre-filter threshold: count of identical tool name in
   * the rolling window before the LLM is invoked. Default 4.
   */
  prefilterCount?: number;
  /**
   * Heuristic pre-filter window in turns. Default 5. Combined with
   * `prefilterCount: 4` → "4 of the same tool in last 5 turns triggers".
   */
  prefilterWindow?: number;
  /**
   * Minimum gap (in turns) between two LLM invocations for the same
   * session. Prevents the watchdog from firing every turn during a
   * sustained loop. Default 5.
   */
  cooldownTurns?: number;
}

/**
 * One tool call as the runner remembers it. Compact — the watchdog
 * doesn't need full args, just names + error status + when.
 */
export interface WatchdogToolCallSnapshot {
  turn: number;
  name: string;
  isError: boolean;
  /** Truncated args preview (≤80 chars) — useful for "same args repeated" cues. */
  argsPreview?: string;
}

export interface WatchdogAnalyzeInput {
  sessionId: number;
  /** Current turn number when the watchdog was invoked. */
  turn: number;
  /** Most recent tool calls, oldest first. Cap ~30 entries. */
  recentToolCalls: WatchdogToolCallSnapshot[];
  /** Last assistant text (truncated) — sometimes the model verbalises
   *  its strategy and the watchdog can detect "intent to loop". */
  lastAssistantText?: string;
}

export interface WatchdogVerdict extends ClassificationVerdict {
  /** Recommended next action — surfaced in the dashboard nudge. */
  recommendedAction: 'stop' | 'nudge' | 'ok';
}

export class QualityWatchdog {
  readonly classifierName = 'tool_loop';
  readonly prefilterCount: number;
  readonly prefilterWindow: number;
  readonly cooldownTurns: number;
  private readonly runChat: WatchdogChatRunner;
  private readonly provider: string;
  private readonly model: string;

  constructor(cfg: QualityWatchdogConfig) {
    this.runChat = cfg.runChat;
    this.provider = cfg.provider;
    this.model = cfg.model;
    this.prefilterCount = cfg.prefilterCount ?? 4;
    this.prefilterWindow = cfg.prefilterWindow ?? 5;
    this.cooldownTurns = cfg.cooldownTurns ?? 5;
  }

  /**
   * Cheap pre-filter — no LLM, just a count check. Returns the tool
   * name that triggered when threshold is exceeded, or `null` to skip.
   *
   * Caller maintains the rolling list of recent tool names; this
   * function only does the count + threshold math so the runner can
   * decide quickly whether to spend LLM tokens.
   */
  shouldRun(recentNames: readonly string[]): { suspectTool: string; count: number } | null {
    if (recentNames.length < this.prefilterCount) return null;
    const window = recentNames.slice(-this.prefilterWindow);
    const counts = new Map<string, number>();
    for (const n of window) counts.set(n, (counts.get(n) ?? 0) + 1);
    let topName = '';
    let topCount = 0;
    for (const [n, c] of counts) {
      if (c > topCount) {
        topCount = c;
        topName = n;
      }
    }
    if (topCount >= this.prefilterCount && topName) {
      return { suspectTool: topName, count: topCount };
    }
    return null;
  }

  /**
   * Run the LLM analysis. Always returns a verdict — errors collapse
   * into a `'error'` verdict so the caller never has to try/catch.
   */
  async analyze(input: WatchdogAnalyzeInput): Promise<WatchdogVerdict> {
    const started = Date.now();
    const callList = input.recentToolCalls
      .slice(-30)
      .map((t) => `${t.isError ? '✗' : '✓'} t${t.turn} ${t.name}${t.argsPreview ? ` ${t.argsPreview}` : ''}`)
      .join('\n');
    const histogram = countByName(input.recentToolCalls);
    const histogramLines = Array.from(histogram.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([n, c]) => `  ${n}: ${c}`)
      .join('\n');
    const userPrompt = [
      `Session ${input.sessionId}, turn ${input.turn}.`,
      '',
      'Tool call histogram (last 30 calls):',
      histogramLines,
      '',
      'Recent tool calls (oldest first):',
      callList,
      input.lastAssistantText
        ? `\nLast assistant text:\n${truncate(input.lastAssistantText, 800)}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');

    const systemPrompt = [
      'CRITICAL OUTPUT RULES:',
      '1. Your ENTIRE response MUST be exactly one JSON object.',
      '2. First char `{`, last char `}`. No markdown fences, no prose.',
      '',
      'You are a quality watchdog for an AI coding agent. You decide whether',
      'the agent is making progress or is stuck in a loop / pointless repetition.',
      '',
      'Schema: { "verdict": "ok" | "warn" | "flagged" | "error",',
      '          "confidence": 0.0-1.0,',
      '          "reason": "<short, mention the suspicious tool name>",',
      '          "recommended_action": "stop" | "nudge" | "ok" }',
      '',
      '"ok" = healthy: tool variety + progress. recommended_action=ok.',
      '"warn" = some repetition but plausible (e.g. iterative edit loop with real progress). recommended_action=ok.',
      '"flagged" = clear stuck loop or pointless repetition. recommended_action=nudge or stop.',
      '',
      'Calibration:',
      '- A single tool dominating ≥60% of recent calls + no error variety + no assistant text → flagged + nudge.',
      '- The same tool with identical args 5+ times → flagged + stop.',
      '- Legitimate iterative refactors (edit→test→edit→test) are ok or warn at most.',
      '- batched reads (read_file × N different files) → ok.',
      '',
      'Remember: respond with ONE JSON object only.',
    ].join('\n');

    let raw = '';
    try {
      const result = await this.runChat({
        system: systemPrompt,
        user: userPrompt,
        maxOutputTokens: 200,
      });
      raw = result.text ?? '';
      const parsed = parseWatchdogJSON(raw);
      return {
        classifierName: this.classifierName,
        verdict: parsed.verdict,
        confidence: parsed.confidence,
        reason: parsed.reason,
        latencyMs: Date.now() - started,
        providerId: this.provider,
        modelId: this.model,
        raw,
        recommendedAction: parsed.recommendedAction,
      };
    } catch (err) {
      return {
        classifierName: this.classifierName,
        verdict: 'error',
        confidence: 0,
        reason: `watchdog call failed: ${err instanceof Error ? err.message : String(err)}`,
        latencyMs: Date.now() - started,
        providerId: this.provider,
        modelId: this.model,
        raw,
        recommendedAction: 'ok',
      };
    }
  }
}

// ─── helpers ────────────────────────────────────────────────────

function countByName(calls: readonly WatchdogToolCallSnapshot[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of calls) m.set(c.name, (m.get(c.name) ?? 0) + 1);
  return m;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

interface ParsedWatchdogJSON {
  verdict: QualityVerdict;
  confidence: number;
  reason: string;
  recommendedAction: 'stop' | 'nudge' | 'ok';
}

/**
 * Parse the watchdog LLM response. Tolerant of:
 *   - extra whitespace
 *   - markdown fences (despite the prompt saying no fences)
 *   - leading `<think>...</think>` blocks
 * Falls back to `error` verdict on any failure rather than throwing.
 */
function parseWatchdogJSON(raw: string): ParsedWatchdogJSON {
  let s = raw.trim();
  // Strip <think> blocks (some reasoning models emit them).
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  // Strip ```json fences.
  const fenceMatch = s.match(/```(?:json)?\s*([\s\S]+?)```/);
  if (fenceMatch) s = fenceMatch[1].trim();
  // Find the first `{` and the matching last `}`.
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return { verdict: 'error', confidence: 0, reason: 'unparseable response', recommendedAction: 'ok' };
  }
  try {
    const obj = JSON.parse(s.slice(start, end + 1)) as Record<string, unknown>;
    const verdict = normalizeVerdict(obj.verdict);
    const recommendedAction = normalizeAction(obj.recommended_action);
    return {
      verdict,
      confidence: typeof obj.confidence === 'number' ? obj.confidence : 0,
      reason: typeof obj.reason === 'string' ? obj.reason : '',
      recommendedAction,
    };
  } catch {
    return { verdict: 'error', confidence: 0, reason: 'JSON parse failed', recommendedAction: 'ok' };
  }
}

function normalizeVerdict(raw: unknown): QualityVerdict {
  if (raw === 'ok' || raw === 'warn' || raw === 'flagged' || raw === 'error') return raw;
  return 'error';
}

function normalizeAction(raw: unknown): 'stop' | 'nudge' | 'ok' {
  if (raw === 'stop' || raw === 'nudge' || raw === 'ok') return raw;
  return 'ok';
}
