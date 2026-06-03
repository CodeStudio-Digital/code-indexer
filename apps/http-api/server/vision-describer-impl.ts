/**
 * Vision describer — MAIN-SIDE real implementation of `IVisionDescriber`.
 *
 * Resolves the `code-agent/vision` Pipelines role to a (provider, model), runs
 * a ONE-OFF chat with the image + the agent-directed prompt (mirrors
 * `runGeneralAi` in @mcp/services/ai-general), and returns the text. Results
 * are memoised in a small process-local LRU keyed by the image bytes + prompt
 * so the same image isn't re-described every turn (it persists in history).
 *
 * Wired in server.ts via `setGlobalVisionDescriber(...)` (in-process coders)
 * and `setCoderWorkerDocDeps/​setCompanyWorkerDocDeps({ vision })` (worker
 * coders reach it back over the MessageBridge). When no row is bound the
 * describe call throws `VISION_NOT_CONFIGURED` and the transform degrades.
 */
import { createHash } from 'node:crypto';
import { createCoderProvider } from '@mcp/services/providers/factory.js';
import type { PipelineProviderResolver } from '@mcp/services/pipelines/provider-resolver.js';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import {
  VISION_NOT_CONFIGURED,
  type IVisionDescriber,
  type VisionDescribeRequest,
} from '@mcp/code-agent/core/vision-describer.js';

const VISION_SYSTEM =
  'You are a vision-to-text describer for a coding agent that CANNOT see images. ' +
  'Given an image and an instruction, produce a faithful, concrete, information-dense ' +
  'description that answers the instruction. Describe ONLY what is visible — never invent ' +
  'content. Be structured and specific: layout and structure, each UI component and its ' +
  'position, text labels, colors, typography, spacing/alignment, and any visible defects ' +
  '(misalignment, overflow, clipping, low contrast) when relevant. No preamble, no markdown fences.';

/** Tiny FIFO/LRU map: re-describing the same image+prompt in one process is free. */
class DescribeCache {
  private map = new Map<string, string>();
  constructor(private cap = 64) {}
  get(key: string): string | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      // bump recency
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: string, value: string): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.cap) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
}

function cacheKey(req: VisionDescribeRequest): string {
  const img = createHash('sha256').update(req.base64).digest('hex');
  const prm = createHash('sha256').update(req.prompt).digest('hex');
  return `${img}:${prm}`;
}

export interface VisionDescriberDeps {
  resolver: PipelineProviderResolver;
}

/**
 * Build the process singleton. The describe prompt is supplied by the caller
 * (the agent via view_image.describe / preview_screenshot.lookFor, or the user
 * message text for composer attachments).
 */
export function createVisionDescriber(deps: VisionDescriberDeps): IVisionDescriber {
  const cache = new DescribeCache();

  return {
    async describe(req: VisionDescribeRequest): Promise<string> {
      const key = cacheKey(req);
      const hit = cache.get(key);
      if (hit !== undefined) return hit;

      const bind = await deps.resolver.resolveOrNull('code-agent', 'vision', {});
      if (!bind) {
        throw new Error(
          `${VISION_NOT_CONFIGURED}: no vision model is bound. Set the ` +
            `code-agent / vision role in Settings → Pipelines.`,
        );
      }

      const provider = await createCoderProvider(bind.provider.id, bind.modelId);
      const messages: AgentMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: req.prompt },
            { type: 'image', mediaType: req.mediaType, base64: req.base64 },
          ],
        },
      ];

      let text = '';
      for await (const delta of provider.chat({
        system: VISION_SYSTEM,
        messages,
        tools: [],
      })) {
        if (delta.type === 'text_delta') text += delta.text;
        if (delta.type === 'done') break;
      }

      const out = text.trim();
      if (out) cache.set(key, out);
      return out;
    },
  };
}
