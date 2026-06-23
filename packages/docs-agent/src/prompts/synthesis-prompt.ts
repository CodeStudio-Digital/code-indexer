/**
 * Builder for the docs_synthesize tool's LLM prompt.
 *
 * The DocsAgent decides the outline and which chunks to cite; this prompt
 * tells a cheaper LLM (resolved via `pipeline_provider_bindings('docs_research','classifier')`)
 * to render the final markdown. Splitting saves ~80% on tokens — the
 * scorer_llm (Sonnet) only emits the outline, not the full prose.
 */
import type { DocChunk } from '@mcp/store/doc-store.js';

export interface SynthesisInput {
  /** The developer's original query — repeated so the LLM stays on-topic. */
  query: string;
  /** Section outline picked by the DocsAgent. */
  outline: string[];
  /**
   * Chunks to draw from. Order matches the chunk_ids array passed to the
   * synthesize tool. The footnote indices in the output map back to this
   * order (chunks[0] → [^1], chunks[1] → [^2], etc.).
   */
  chunks: DocChunk[];
}

const SYSTEM_PROMPT = `You are a technical documentation writer. You receive a developer's question, an outline picked by another agent, and a numbered list of doc passages. You produce a concise markdown answer.

Rules:
1. Use the outline as section structure (## headings).
2. Cite EVERY factual claim with a footnote [^N] where N is the 1-based passage index. NEVER invent claims that aren't in the passages.
3. Include code blocks verbatim from the passages when relevant. Don't translate code to prose.
4. If the outline has a section the passages don't cover, write "_(not covered in the available docs)_" under that heading — do NOT make stuff up.
5. End with a "## Sources" section listing each cited passage:
   [^1]: \`<heading_path>\` — \`<source_uri>\`
   [^2]: ...
   Only include passages you actually cited.
6. Keep it tight — aim for 400-1200 words. The caller wants useful prose, not a wall of text.

Respond ONLY with the markdown. No prose around it, no JSON, no \`\`\` fences wrapping the whole thing.`;

export interface SynthesisPrompt {
  system: string;
  user: string;
}

export function buildSynthesisPrompt(input: SynthesisInput): SynthesisPrompt {
  const passages = input.chunks
    .map((chunk, idx) => {
      const head = `### Passage ${idx + 1}\nHeading: ${chunk.heading_path ?? '(untitled)'}`;
      const src = chunk.source_uri ? `\nSource: ${chunk.source_uri}` : '';
      const concepts = chunk.concepts.length > 0 ? `\nConcepts: ${chunk.concepts.join(', ')}` : '';
      // Cap at 2500 chars per chunk — leaves room for ~20 passages within
      // a 60k-context window after system + outline.
      const body = chunk.content.length > 2500 ? chunk.content.slice(0, 2500) + '…' : chunk.content;
      return `${head}${src}${concepts}\n---\n${body}\n`;
    })
    .join('\n');

  const outline = input.outline.map((s, i) => `${i + 1}. ${s}`).join('\n');

  const user = `# Developer's question\n\n${input.query}\n\n# Outline (use as ## headings, in this order)\n\n${outline}\n\n# Passages\n\n${passages}\n\nWrite the markdown answer now.`;

  return { system: SYSTEM_PROMPT, user };
}
