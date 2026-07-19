import { prompt, toast, type PromptOptions } from '../../../components/ui/prompt-dialog.js';
import { apiCall } from '../../../lib/api-client.js';
import type { ContribEditorAction } from '../../../state/contribution-registry.js';
import type { PluginEditorContext } from './plugin-editor-gutter.js';
import type { PluginGutterMarker } from './plugin-editor-gutter.js';

interface PluginToolResponse {
  content?: string;
  isError?: boolean;
}

function description(response: PluginToolResponse): string | undefined {
  const content = response.content?.trim();
  if (!content) return undefined;
  return content.length > 280 ? `${content.slice(0, 277)}...` : content;
}

type ChoicePrompt = (options: PromptOptions) => Promise<string | null>;

/** Require an explicit host-owned choice when plugins share one gutter slot. */
export async function choosePluginGutterMarker(
  markers: readonly PluginGutterMarker[],
  ask: ChoicePrompt = prompt,
): Promise<PluginGutterMarker | undefined> {
  if (markers.length <= 1) return markers[0];

  const answer = await ask({
    title: 'Choose editor action',
    description: markers
      .map((marker, index) => `${index + 1}. ${marker.action.label} (${marker.action.pluginNs})`)
      .join('  \u00b7  '),
    placeholder: `1-${markers.length}`,
    confirmLabel: 'Run action',
    validate: (value) => {
      const normalized = value.trim();
      if (!/^\d+$/.test(normalized)) return `Enter a number from 1 to ${markers.length}`;
      const selected = Number(normalized);
      return selected >= 1 && selected <= markers.length
        ? null
        : `Enter a number from 1 to ${markers.length}`;
    },
  });
  if (answer == null || !/^\d+$/.test(answer.trim())) return undefined;
  const selected = Number(answer.trim());
  return selected >= 1 && selected <= markers.length ? markers[selected - 1] : undefined;
}

export async function runPluginEditorAction(
  action: ContribEditorAction,
  projectId: number,
  editorContext?: PluginEditorContext,
): Promise<PluginToolResponse | undefined> {
  if (!action.runsTool) return undefined;
  try {
    const args: Record<string, unknown> = { ...(action.toolArgs ?? {}) };
    if (editorContext) args._editor = editorContext;
    const response = await apiCall<PluginToolResponse>('plugins.invokeTool', {
      namespace: action.pluginNs,
      tool: action.runsTool,
      args,
      projectId,
    });
    const detail = description(response);
    if (response.isError) toast.error(action.label, { description: detail });
    else toast.success(action.label, { description: detail });
    return response;
  } catch (error) {
    toast.error(action.label, { description: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
}
