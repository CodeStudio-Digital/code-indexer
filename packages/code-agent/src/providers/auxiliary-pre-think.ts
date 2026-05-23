/**
 * DeepThink simulado — helper isolado.
 *
 * Faz uma única chamada one-shot a um ChatProvider auxiliar (modelo barato),
 * acumula o texto streamed e devolve o pré-pensamento que o runner injeta
 * como bloco <thinking data-source="aux"> antes de chamar o modelo principal.
 *
 * Sem estado. O runner constrói o provider e chama esta função por turno.
 */

import type { ChatProvider } from './adapter.js';
import type { AgentMessage, ChatUsage } from '@mcp/code-agent/core/messages.js';

const AUX_SYSTEM = [
  'You are a planning assistant.',
  'The main coding agent is about to respond to the user.',
  'Output 2-5 short sentences of inner reasoning about what the agent should do next:',
  'which tool to call, what to look for, what edge case to remember, what to avoid.',
  'Write in plain text. No XML tags, no markdown headers, no tool calls, no lists.',
].join(' ');

export interface PreThinkRequest {
  provider: ChatProvider;
  messages: AgentMessage[];
  toolNames: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
  onDelta?: (chunk: string) => void;
}

export interface PreThinkResult {
  text: string;
  usage: ChatUsage | undefined;
}

/**
 * Idle window — once we've received at least one text chunk, if no further
 * chunk arrives within this many ms we assume the provider is done and
 * close the stream gracefully (treating it as a successful completion with
 * whatever text we have). Typical inter-chunk gap from any provider is
 * well under 500ms; 2500ms is conservative.
 *
 * This works around providers (notably Codex / ChatGPT) that occasionally
 * stream a full response and then hold the connection open without ever
 * emitting `done` — which used to wedge the `for await` until the hard
 * timeout fired and discarded the perfectly good text.
 */
const IDLE_AFTER_TEXT_MS = 2_500;

export async function runPreThink(req: PreThinkRequest): Promise<PreThinkResult> {
  const toolHint = req.toolNames.length
    ? `\n\nTools the main agent has available: ${req.toolNames.join(', ')}.`
    : '';

  const hardTimeoutMs = req.timeoutMs && req.timeoutMs > 0 ? req.timeoutMs : 60_000;

  // Local controller that bridges:
  //   - user-supplied req.signal (forwarded if caller cancels)
  //   - hard timeout (entire aux call)
  //   - idle timeout (close gracefully when text stream stalls)
  const ctrl = new AbortController();
  const onExternalAbort = (): void => ctrl.abort();
  if (req.signal) {
    if (req.signal.aborted) ctrl.abort();
    else req.signal.addEventListener('abort', onExternalAbort);
  }

  const hardTimer = setTimeout(() => ctrl.abort(), hardTimeoutMs);
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let idleClosed = false;
  const resetIdleTimer = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleClosed = true;
      ctrl.abort();
    }, IDLE_AFTER_TEXT_MS);
  };

  let text = '';
  let usage: ChatUsage | undefined;
  let streamThrew: unknown = null;

  // Wrap the stream consumer in its own async function so we can race it
  // against an abort-resolve below. We have to do this because not every
  // provider respects the AbortSignal we pass into chat() — notably the
  // Codex/ChatGPT adapter ignored it for ages. With the race we return
  // as soon as ctrl.abort() fires regardless of whether the underlying
  // stream actually terminates.
  const streamPromise = (async () => {
    try {
      const stream = req.provider.chat({
        system: AUX_SYSTEM + toolHint,
        messages: req.messages,
        tools: [],
        signal: ctrl.signal,
      });
      for await (const delta of stream) {
        switch (delta.type) {
          case 'text_delta':
            text += delta.text;
            req.onDelta?.(delta.text);
            // Arm the idle watchdog ONLY after the first chunk — before
            // that, the slow hard timeout governs (a slow first-token
            // model shouldn't be killed prematurely).
            resetIdleTimer();
            break;
          case 'usage':
            usage = delta.usage;
            break;
          default:
            break;
        }
      }
    } catch (err) {
      streamThrew = err;
    }
  })();

  // Resolves shortly after ctrl.abort() fires — even if the provider
  // never closes its stream. Tiny grace period (~50ms) so any in-flight
  // delta on the wire still has a chance to land before we return.
  const abortRace = new Promise<void>((resolve) => {
    if (ctrl.signal.aborted) {
      setTimeout(resolve, 50);
      return;
    }
    ctrl.signal.addEventListener('abort', () => {
      setTimeout(resolve, 50);
    }, { once: true });
  });

  try {
    await Promise.race([streamPromise, abortRace]);
  } finally {
    clearTimeout(hardTimer);
    if (idleTimer) clearTimeout(idleTimer);
    if (req.signal) req.signal.removeEventListener('abort', onExternalAbort);
  }

  // Outcome decision tree:
  //   1. Got text  → graceful return (idle close, full stream, or partial
  //                   text on hard timeout — all useful to the main model)
  //   2. Stream threw a real error → propagate
  //   3. External cancel → propagate as abort
  //   4. Hard timeout w/o text → pre_think_timeout
  //   5. Stream finished naturally with no text → empty result (caller
  //      may persist as data-empty marker if usage>0)
  if (text.length > 0) {
    return { text: text.trim(), usage };
  }
  if (streamThrew) {
    const isAbort = (streamThrew as { name?: string })?.name === 'AbortError'
      || /aborted|abort/i.test((streamThrew as Error)?.message ?? '');
    if (!isAbort) throw streamThrew;
  }
  if (req.signal?.aborted) {
    throw streamThrew instanceof Error ? streamThrew : new Error('aborted');
  }
  if (ctrl.signal.aborted && !idleClosed) {
    // Hard timeout fired before any text arrived.
    throw new Error('pre_think_timeout');
  }
  return { text: '', usage };
}
