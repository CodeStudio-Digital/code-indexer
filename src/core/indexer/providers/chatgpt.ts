/**
 * ChatGPT (Codex PKCE OAuth) indexer adapter.
 *
 * Single-shot analogue of src/coder/providers/chatgpt.ts — the indexer
 * only ever does one `analyzeFile` call per file, so we use the Responses
 * API in non-streaming mode and extract the text output. Mirrors opencode's
 * Codex plugin semantics: Bearer access_token + ChatGPT-Account-Id header +
 * originator / User-Agent / session_id.
 */
import OpenAI from 'openai';
import { randomUUID } from 'node:crypto';
import type { LLMProvider } from './base.js';
import { SYSTEM_PROMPT, buildUserPrompt, parseAnalysisResponse } from './base.js';
import type { AnalysisResult } from '../../../types.js';

export class ChatGPTProvider implements LLMProvider {
  readonly name = 'chatgpt';
  readonly model: string;
  private client: OpenAI;
  private sessionId: string;

  constructor(opts: {
    apiKey: string;
    model?: string;
    baseURL: string;
    accountId?: string | null;
  }) {
    this.model = opts.model ?? 'gpt-5.3-codex';
    this.sessionId = randomUUID();

    const headers: Record<string, string> = {
      originator: 'codex_cli_rs',
      'User-Agent': 'codex_cli_rs/0.1.0',
      session_id: this.sessionId,
    };
    if (opts.accountId) headers['ChatGPT-Account-Id'] = opts.accountId;

    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      defaultHeaders: headers,
    });
  }

  async analyzeFile(filePath: string, content: string): Promise<AnalysisResult> {
    // Single-shot call to the Responses API. The SDK's responses.create
    // typing has drifted between versions, so cast through unknown.
    const resp = (await (this.client as unknown as {
      responses: {
        create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };
    }).responses.create({
      model: this.model,
      instructions: SYSTEM_PROMPT,
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: buildUserPrompt(filePath, content) }],
        },
      ],
      stream: false,
      store: false,
    })) as {
      output_text?: string;
      output?: Array<{
        type: string;
        content?: Array<{ type: string; text?: string }>;
      }>;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
      };
    };

    // Prefer the convenience `output_text`; fall back to scanning the
    // output array for the first message item's text content.
    let text = resp.output_text ?? '';
    if (!text && resp.output) {
      for (const item of resp.output) {
        if (item.type !== 'message' || !item.content) continue;
        for (const c of item.content) {
          if (c.type === 'output_text' && c.text) text += c.text;
        }
      }
    }
    if (!text) text = '{}';

    return {
      analysis: parseAnalysisResponse(text, filePath),
      inputTokens: resp.usage?.input_tokens ?? 0,
      outputTokens: resp.usage?.output_tokens ?? 0,
    };
  }
}
