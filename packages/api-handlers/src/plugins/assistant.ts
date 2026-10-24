/**
 * Scoped plugin assistant — the host side of `plugins.assistantStream` /
 * `assistantConfirm` / `listModels`. Runs the generic mini-agent with ONLY the
 * plugin's own tools (executed through the injected `invokeTool`, so
 * capabilities stay enforced) under a guardrail system prompt that locks the
 * model to the plugin's domain.
 *
 * Confirmation over a one-way stream: a mutating tool emits `confirm_request`
 * and parks a promise in `pendingConfirms`; the separate `assistantConfirm`
 * one-shot resolves it — so the UI streams + clicks Approve/Deny with no duplex.
 */
import { runMiniAgent, type MiniTool } from '@mcp/services/mini-agent/index.js';
import { createCoderProvider } from '@mcp/services/providers/factory.js';
import { getInstalledPlugin } from '@mcp/plugin-host';
import type { PluginAssistantChunk, PluginModelOption } from '@mcp/api-bus';
import type { AgentMessage } from "@mcp/provider-sdk";

interface ToolDecl {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  mutates?: boolean;
}

/** Executor injected by the handler (wraps deps.invokePluginTool). */
export type ToolInvoker = (
  namespace: string,
  tool: string,
  args: Record<string, unknown>,
  ctx: { projectName: string | null; cwd: string },
) => Promise<{ content: string; isError?: boolean }>;

/** Minimal ProviderStore surface the model selector needs. */
export interface ModelStore {
  listProviders(filter?: { enabled?: boolean }): Array<{ id: string; kind: string; name: string }>;
  listModels(providerId: string, onlyEnabled?: boolean): Array<{ model_id: string }>;
  getGeneralDefault(): { providerId: string; modelId: string } | null;
}

const pendingConfirms = new Map<string, (approved: boolean) => void>();

export function resolveAssistantConfirm(callId: string, approved: boolean): void {
  const fn = pendingConfirms.get(callId);
  if (fn) {
    pendingConfirms.delete(callId);
    fn(approved);
  }
}

export function listAssistantModels(store: ModelStore): PluginModelOption[] {
  const def = store.getGeneralDefault();
  const out: PluginModelOption[] = [];
  for (const p of store.listProviders({ enabled: true })) {
    for (const m of store.listModels(p.id, true)) {
      out.push({
        providerId: p.id,
        modelId: m.model_id,
        label: `${p.name || p.kind} · ${m.model_id}`,
        isDefault: def?.providerId === p.id && def?.modelId === m.model_id,
      });
    }
  }
  return out;
}

function guardrail(pluginName: string, tools: ToolDecl[], guidance: string[]): string {
  const names = tools.map((t) => t.name).join(', ');
  const base = [
    `You are the ${pluginName} assistant, scoped STRICTLY to ${pluginName}.`,
    `You may ONLY use these tools: ${names}.`,
    `If a request needs anything outside ${pluginName} — other clouds, the local`,
    `filesystem, arbitrary shell, unrelated topics — REFUSE briefly and say you`,
    `are limited to ${pluginName}. Never invent tools. Prefer a read/list tool to`,
    `inspect state before a mutating one. Be concise.`,
  ].join(' ');
  // Plugin-declared persona (interface.assistantGuidance). Appended AFTER the
  // safety guardrail so domain advice can't relax the tool/scope limits.
  return guidance.length ? `${base}\n\n${guidance.join(' ')}` : base;
}

/** Read `interface.assistantGuidance` from a stored plugin manifest, defensively. */
function manifestGuidance(manifest: unknown): string[] {
  const iface = (manifest as { interface?: { assistantGuidance?: unknown } } | null)?.interface;
  const lines = iface?.assistantGuidance;
  return Array.isArray(lines) ? lines.filter((x): x is string => typeof x === 'string') : [];
}

export interface AssistantRunInput {
  namespace: string;
  message: string;
  providerId?: string;
  modelId?: string;
  projectName: string | null;
  cwd: string;
  history?: Array<{ role: 'user' | 'assistant'; text: string }>;
  invokeTool: ToolInvoker;
  signal?: AbortSignal;
}

export async function* runPluginAssistant(
  input: AssistantRunInput,
): AsyncGenerator<PluginAssistantChunk> {
  const plugin = getInstalledPlugin(input.namespace);
  if (!plugin || !plugin.enabled) {
    yield { type: 'error', message: `plugin ${input.namespace} not enabled` };
    return;
  }
  const decls = ((plugin.contributions as { tools?: ToolDecl[] } | null)?.tools ?? []) as ToolDecl[];
  if (decls.length === 0) {
    yield { type: 'error', message: `plugin ${input.namespace} has no tools` };
    return;
  }

  let provider;
  try {
    provider = await createCoderProvider(input.providerId, input.modelId);
  } catch (e) {
    yield { type: 'error', message: e instanceof Error ? e.message : String(e) };
    return;
  }

  const tools: MiniTool[] = decls.map((d) => ({
    name: d.name,
    description: d.description,
    parameters: d.parameters ?? { type: 'object', properties: {} },
    mutates: d.mutates,
    handler: (args) =>
      input.invokeTool(input.namespace, d.name, args, {
        projectName: input.projectName,
        cwd: input.cwd,
      }),
  }));

  const messages: AgentMessage[] = [
    ...(input.history ?? []).map((h) => ({
      role: h.role,
      content: [{ type: 'text' as const, text: h.text }],
    })),
    { role: 'user', content: [{ type: 'text', text: input.message }] },
  ];

  // MiniDelta is structurally identical to PluginAssistantChunk.
  yield* runMiniAgent({
    provider,
    system: guardrail(plugin.name, decls, manifestGuidance(plugin.manifest)),
    tools,
    messages,
    signal: input.signal,
    confirm: (call) =>
      new Promise<boolean>((resolve) => {
        pendingConfirms.set(call.callId, resolve);
        input.signal?.addEventListener('abort', () => resolve(false), { once: true });
      }),
  }) as AsyncGenerator<PluginAssistantChunk>;
}
