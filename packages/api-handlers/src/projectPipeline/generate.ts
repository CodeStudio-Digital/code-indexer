/**
 * Generate a pipeline graph from a natural-language description.
 *
 * Mirrors the git AI-plan pattern: build a strict-JSON prompt, call the
 * general AI provider, strip fences, parse. The returned graph is NOT
 * trusted — the HTTP route runs it through `validatePipelineGraph` before
 * handing it to the builder, so a malformed graph surfaces as validation
 * issues rather than a broken canvas.
 */
import type { PipelineGraph } from '@mcp/company-contracts';
import type { HandlerDeps } from '../types.js';
import { callGeneralAiJson, stripJsonFences } from '../aiJson.js';
import { buildPipelinePrompt, type PipelinePromptCtx } from './prompt.js';

export interface GeneratePipelineResult {
  graph?: PipelineGraph;
  summary: string;
  refusal?: string;
}

export async function generateAiPipeline(
  deps: HandlerDeps,
  intent: string,
  ctx: PipelinePromptCtx,
): Promise<GeneratePipelineResult> {
  if (!intent.trim()) return { summary: '', refusal: 'Describe the workflow you want to build.' };

  const { system, user } = buildPipelinePrompt(intent, ctx);
  const res = await callGeneralAiJson(deps, { system, user, maxTokens: 2000 });
  if ('refusal' in res) return { summary: '', refusal: res.refusal };

  const cleaned = stripJsonFences(res.raw);
  try {
    const parsed = JSON.parse(cleaned) as {
      summary?: string;
      refusal?: string;
      nodes?: unknown[];
      edges?: unknown[];
    };
    if (typeof parsed.refusal === 'string' && parsed.refusal) {
      return { summary: '', refusal: parsed.refusal };
    }
    const graph: PipelineGraph = {
      version: 1,
      nodes: (Array.isArray(parsed.nodes) ? parsed.nodes : []) as PipelineGraph['nodes'],
      edges: (Array.isArray(parsed.edges) ? parsed.edges : []) as PipelineGraph['edges'],
    };
    return { graph, summary: typeof parsed.summary === 'string' ? parsed.summary : '' };
  } catch {
    return { summary: '', refusal: `AI returned unparseable JSON. Raw response: ${cleaned.slice(0, 200)}` };
  }
}
