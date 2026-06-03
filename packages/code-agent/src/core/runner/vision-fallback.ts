/**
 * Vision fallback — replace image blocks with agent-directed TEXT descriptions
 * for models that can't see (or when the composer "Describe images" flag is on).
 *
 * Called from the executing node right before `provider.chat(...)`, on a COPY
 * of the assembled messages — `ctx.messages` (the history) is never mutated, so
 * the raw image survives for a later vision-capable turn / model switch.
 *
 * The describing prompt is agent-directed: `block.describeHint` (set from
 * view_image.describe / preview_screenshot.lookFor) wins; else the nearest user
 * text PRECEDING the image in the same message (a composer attachment carries
 * the user request before the image); else a generic UI-focused default.
 *
 * Degrades gracefully: no describer wired → emit an "omitted" note; describe
 * throws → keep the raw image block + an "unavailable" note.
 */
import type { AgentMessage, ContentBlock, ImageBlock, TextBlock } from '@mcp/code-agent/core/messages.js';
import type { IVisionDescriber } from '@mcp/code-agent/core/vision-describer.js';

const DEFAULT_UI_PROMPT =
  'Describe this image in detail for a developer who cannot see it: the overall layout and ' +
  'structure, every UI component and its position, text labels, colors, typography, spacing ' +
  'and alignment, and any visible visual defects (misalignment, overflow, clipping, low contrast).';

const OMITTED_NOTE =
  '[Image omitted: this model cannot view images and no vision model is configured. ' +
  'Ask the user to set the code-agent / vision role in Settings → Pipelines.]';

export interface VisionFallbackOptions {
  messages: AgentMessage[];
  /** When false, returns `messages` unchanged. */
  gate: boolean;
  describer: IVisionDescriber | null;
  signal?: AbortSignal;
}

/** First non-empty text block that appears BEFORE `imageIdx` in `content`. */
function precedingText(content: ContentBlock[], imageIdx: number): string | undefined {
  for (let i = imageIdx - 1; i >= 0; i--) {
    const b = content[i];
    if (b.type === 'text' && (b as TextBlock).text.trim()) return (b as TextBlock).text.trim();
  }
  return undefined;
}

function describePrompt(block: ImageBlock, content: ContentBlock[], idx: number): string {
  return block.describeHint?.trim() || precedingText(content, idx) || DEFAULT_UI_PROMPT;
}

/**
 * Return a new message array where every image block is swapped for a text
 * description (or a degradation note). Non-image content is passed through.
 */
export async function applyVisionFallback(opts: VisionFallbackOptions): Promise<AgentMessage[]> {
  if (!opts.gate) return opts.messages;

  const out: AgentMessage[] = [];
  for (const msg of opts.messages) {
    const hasImage = msg.content.some((b) => b.type === 'image');
    if (!hasImage) {
      out.push(msg);
      continue;
    }

    const newContent: ContentBlock[] = [];
    for (let i = 0; i < msg.content.length; i++) {
      const block = msg.content[i];
      if (block.type !== 'image') {
        newContent.push(block);
        continue;
      }

      if (!opts.describer) {
        newContent.push({ type: 'text', text: OMITTED_NOTE });
        continue;
      }

      const prompt = describePrompt(block, msg.content, i);
      try {
        const desc = await opts.describer.describe({
          base64: block.base64,
          mediaType: block.mediaType,
          prompt,
        });
        newContent.push({
          type: 'text',
          text: desc ? `[Image description]\n${desc}` : '[Image description: the vision model returned nothing.]',
        });
      } catch (e) {
        // Keep the raw image (a later vision-capable model could still use it)
        // plus a visible note so the blind model knows the describe failed.
        newContent.push(block);
        newContent.push({
          type: 'text',
          text: `[Image description unavailable: ${e instanceof Error ? e.message : String(e)}]`,
        });
      }
    }

    out.push({ ...msg, content: newContent });
  }
  return out;
}
