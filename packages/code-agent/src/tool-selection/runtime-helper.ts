/**
 * Runtime helper that wraps tool-list construction with the
 * ToolSelectionPipeline.
 *
 * Pattern:
 *
 *   const filteredTools = await applyToolSelection({
 *     allTools,
 *     taskText: lastUserMessage,
 *     recentToolEvents: history.flatMap(...),
 *     tier: 'navigate',
 *     k: 12,
 *     pipeline,
 *     onResult: (diag) => console.log(`saved ~${diag.estimatedTokensSaved} tokens`),
 *   });
 *
 * Returns the original `allTools` array if the pipeline is disabled or
 * fails — never throws. This makes integration trivial: callers can opt
 * in by passing a pipeline, and stay safe when it's absent.
 */
import type { CandidatePipeline } from '@mcp/candidate-pipeline';
import { selectTools, type SelectToolsResult } from './tool-selection-pipeline.js';
import type { ToolCandidate, ToolSelectionQuery } from './types.js';
import type { CoderTool } from '../core/tool.js';

export interface ApplyToolSelectionOptions {
  allTools: CoderTool[];
  taskText: string;
  recentToolEvents?: ToolSelectionQuery['recentToolEvents'];
  tier?: ToolSelectionQuery['tier'];
  k?: number;
  /** When undefined or null, returns `allTools` unchanged. */
  pipeline?: CandidatePipeline<ToolSelectionQuery, ToolCandidate> | null;
  /** Callback fired with the pipeline diagnostics — surface in telemetry. */
  onResult?: (diag: SelectToolsResult['diag']) => void;
  /** When the task text is shorter than this, skip selection (too little signal). */
  minTaskLength?: number;
  /** Override for the pipeline query id, useful for trace correlation. */
  queryId?: string;
}

const DEFAULT_MIN_TASK_LENGTH = 8;

export async function applyToolSelection(options: ApplyToolSelectionOptions): Promise<CoderTool[]> {
  const { allTools, pipeline, taskText } = options;
  if (!pipeline) return allTools;
  const minLen = options.minTaskLength ?? DEFAULT_MIN_TASK_LENGTH;
  if (!taskText || taskText.trim().length < minLen) return allTools;

  try {
    const result = await selectTools(pipeline, {
      queryId: options.queryId ?? `tool-selection-${Date.now()}`,
      taskText,
      recentToolEvents: options.recentToolEvents,
      tier: options.tier,
      k: options.k,
    });
    options.onResult?.(result.diag);
    // Sanity: never return EMPTY. If the pipeline somehow strips
    // everything, fall back to the unfiltered list.
    if (result.selected.length === 0) return allTools;
    return result.selected;
  } catch {
    // Pipeline errors must never break the agent runtime.
    return allTools;
  }
}
