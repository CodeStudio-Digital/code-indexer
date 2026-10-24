/**
 * General-AI client — a thin wrapper around the coder ChatProvider for
 * utility tasks (commit message suggestion, short text generation, etc).
 *
 * Why not reuse the coder runner? The runner owns turns, tool loops, session
 * bookkeeping, persistence — heavy machinery designed for agents. General AI
 * is just "prompt in, string out", single turn, no tools. Routing it through
 * the runner would bring along a lot of state we don't want to spin up for a
 * commit message.
 *
 * Backend resolution:
 *   - Reads the operator selection via `ProviderStore.getGeneralDefault()`
 *     (see migration 041 + provider-store).
 *   - Instantiates the provider via the existing coder factory so auth,
 *     base-url and credential refresh stay consistent with the rest of the
 *     system.
 *
 * Errors surface a specific message ("general AI is not configured") that
 * the HTTP layer maps to a 412 so the UI can prompt the operator to open the
 * Admin → AI Geral panel.
 */
import { createCoderProvider } from '../providers/factory.js';
import { getStore } from '../providers/shared/store.js';
import type { AgentMessage } from "@mcp/provider-sdk";

export class GeneralAiNotConfiguredError extends Error {
  constructor() {
    super(
      'General AI is not configured. Open Admin → AI Geral and pick a provider + model.',
    );
    this.name = 'GeneralAiNotConfiguredError';
  }
}

export interface RunGeneralAiOpts {
  /** Optional system prompt. Defaults to a concise, terse utility persona. */
  system?: string;
  /** Abort signal passed through to the provider. */
  signal?: AbortSignal;
}

const DEFAULT_SYSTEM =
  'You are a concise utility assistant. Respond with exactly what is asked ' +
  'and nothing else — no preamble, no markdown fences, no explanations.';

/**
 * Send a single-turn prompt to the operator-selected general-AI model and
 * return the concatenated text response.
 */
export async function runGeneralAi(
  prompt: string,
  opts: RunGeneralAiOpts = {},
): Promise<string> {
  const store = getStore();
  if (!store) throw new GeneralAiNotConfiguredError();

  const selection = store.getGeneralDefault();
  if (!selection) throw new GeneralAiNotConfiguredError();

  const provider = await createCoderProvider(selection.providerId, selection.modelId);

  const messages: AgentMessage[] = [
    { role: 'user', content: [{ type: 'text', text: prompt }] },
  ];

  let text = '';
  for await (const delta of provider.chat({
    system: opts.system ?? DEFAULT_SYSTEM,
    messages,
    tools: [],
    signal: opts.signal,
  })) {
    if (delta.type === 'text_delta') text += delta.text;
    if (delta.type === 'done') break;
  }

  return text.trim();
}
