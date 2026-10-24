import type { CoderTool, ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import { unknownToolOutcome } from '@mcp/code-agent/core/tool.js';
import { isUncertainToolOutcomeError } from './uncertain-tool-outcome.js';
import { aliasNormalizationEnabled, normalizeToolArgs } from '@mcp/code-agent/core/tool-arg-aliases.js';
import { suggestToolName } from '@mcp/code-agent/core/tool-name-suggest.js';
import { resolveToolMetadata } from '@mcp/code-agent/core/policy.js';
import {
  combinedMutationSignal,
  MutationFenceError,
} from '@mcp/code-agent/core/mutation-fence.js';
import { defaultLocalFilesystemPort } from '@mcp/code-agent/ports/filesystem-port.js';
import { defaultLocalShellPort } from '@mcp/code-agent/ports/shell-port.js';
import { toolSettlementNotifier } from './tool-settlement.js';
import { asAbortSignal } from './abort-signal.js';
import { runWithSnapshotInvocation } from '../ports/snapshot-invocation.js';
import {
  mutationFencedFilesystemPort,
  mutationFencedShellPort,
  runWithMutationFence,
} from '@mcp/code-agent/ports/mutation-fenced-ports.js';

/**
 * In-memory registry that holds the union of native + MCP tools available
 * in a coder session. The runner queries it to (a) build the tools array
 * sent to the provider and (b) dispatch tool calls returned by the model.
 */
export class ToolRegistry {
  private tools = new Map<string, CoderTool>();
  private sealed = false;

  register(tool: CoderTool): void {
    if (this.sealed) {
      throw new Error(
        `ToolRegistry attempt snapshot is sealed; '${tool.name}' is available only to a successor attempt`,
      );
    }
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool '${tool.name}' already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  registerAll(tools: CoderTool[]): void {
    for (const t of tools) this.register(t);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): CoderTool | undefined {
    return this.tools.get(name);
  }

  list(): CoderTool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Freeze membership for the current attempt. Tool handlers and runner-local
   * projection state remain live, but a late MCP/plugin cannot silently grant
   * a capability that was absent from the launch snapshot.
   */
  seal(): void {
    this.sealed = true;
  }

  get isSealed(): boolean {
    return this.sealed;
  }

  /**
   * Remove all tools that do not satisfy the predicate.
   * Used by the Master agent filter to strip code-level tools.
   */
  filterInPlace(predicate: (tool: CoderTool) => boolean): void {
    if (this.sealed) {
      throw new Error('ToolRegistry attempt snapshot is sealed; filtering must happen before launch');
    }
    for (const [name, tool] of this.tools) {
      if (!predicate(tool)) {
        this.tools.delete(name);
      }
    }
  }

  async invoke(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (ctx.toolCallLedger?.outcomeUnknownTool) {
      return unknownToolOutcome(`Dispatch blocked: the outcome of ${ctx.toolCallLedger.outcomeUnknownTool} is unresolved.`);
    }
    if (asAbortSignal(ctx.signal)?.aborted) return cancelledBeforeDispatch(name);
    const tool = this.tools.get(name);
    if (!tool) {
      // Deterministic recovery breadcrumbs: a close-name suggestion (telemetry
      // caught `grep_code` for `mcp__grep_code`) and the discovery tool when
      // this session actually has it registered.
      const suggestion = suggestToolName(name, Array.from(this.tools.keys()));
      const didYouMean = suggestion ? ` Did you mean \`${suggestion}\`?` : '';
      const discovery = this.tools.has('find_tools')
        ? ' Call find_tools to list available tools.'
        : '';
      return {
        content: `Unknown tool: ${name}.${didYouMean}${discovery}`,
        isError: true,
        error: {
          code: 'UNKNOWN_TOOL',
          kind: 'invalid_input',
          retryable: false,
          suggestedAction: 'Use find_tools or list_tools to discover the exact tool name.',
        },
      };
    }
    // Tag the recording filesystem port with the current tool name so its
    // audit log shows the actual mutating tool (apply_patch / edit_file /
    // multi_edit / etc.) instead of a generic "write_file" default.
    const fsPort = ctx.ports?.fs as { setCurrentTool?: (n: string) => void } | undefined;
    if (fsPort && typeof fsPort.setCurrentTool === 'function') {
      try { fsPort.setCurrentTool(name); } catch { /* never let telemetry break tool dispatch */ }
    }
    // Silently repair common wrong argument names (e.g. `file_path` → `path`)
    // against the tool's own schema before dispatch. Invisible to the model;
    // see tool-arg-aliases.ts. This is the single chokepoint for ALL tool
    // calls — the runner loop, subagents, and code_exec's nested calls.
    const finalArgs = aliasNormalizationEnabled() ? normalizeToolArgs(tool.parameters, args) : args;
    let notify: ((result: Pick<ToolResult, 'isError'>) => void) | undefined;
    try {
      let invocationContext = ctx;
      if (ctx.mutationFence) {
        const metadata = resolveToolMetadata(tool);
        let dynamicRisk = metadata.riskLevel;
        if (tool.riskOf) {
          try {
            dynamicRisk = tool.riskOf(finalArgs);
          } catch {
            dynamicRisk = 'write';
          }
        }
        const requiresEffectBoundary = metadata.mutates
          || metadata.executionClass !== 'read'
          || dynamicRisk !== 'read'
          || tool.effectBoundary !== undefined
          || (tool.source === 'mcp_external' && tool.mutates !== false);
        const mutationFence = ctx.mutationFence.bindInvocation({
          toolName: name,
          toolUseId: ctx.currentToolUseId ?? ctx.approvalAnchorId ?? name,
          effectiveInput: finalArgs,
          boundary: tool.effectBoundary,
          requiresEffectBoundary,
        });
        const rawFs = ctx.ports?.fs ?? defaultLocalFilesystemPort();
        const rawShell = ctx.ports?.shell ?? defaultLocalShellPort();
        if (mutationFence.mode === 'enforce'
          && tool.effectBoundary === 'filesystem'
          && rawFs.mutationFenceAttested !== true) {
          throw new MutationFenceError(
            'unsupported_port',
            `${name} filesystem adapter has no attested physical mutation boundary`,
          );
        }
        if (mutationFence.mode === 'enforce'
          && tool.effectBoundary === 'shell'
          && rawShell.mutationFenceAttested !== true) {
          throw new MutationFenceError(
            'unsupported_port',
            `${name} shell adapter has no attested physical mutation boundary`,
          );
        }
        invocationContext = {
          ...ctx,
          currentToolInvocation: { name, input: finalArgs },
          mutationFence,
          signal: combinedMutationSignal(ctx.signal, mutationFence),
          // Ports are rebound per invocation. The wrappers resolve the bound
          // fence through AsyncLocalStorage, so concurrent A/B calls cannot
          // observe each other's input/resource binding.
          ports: {
            ...ctx.ports,
            fs: mutationFencedFilesystemPort(
              rawFs,
              () => mutationFence,
            ),
            shell: mutationFencedShellPort(
              rawShell,
              () => mutationFence,
            ),
          },
        };
        if (tool.effectBoundary === 'control') {
          // In-process control tools declare handler entry as their physical
          // boundary. Other kinds revalidate inside their port/adapter.
          mutationFence.assertMutation({
            kind: 'control',
            operation: name,
            resource: name,
          });
        }
      }
      notify = toolSettlementNotifier(invocationContext, name, finalArgs);
      const invoke = async () => {
        // Admission may have waited for another workspace owner. Cancellation
        // during that wait must not start a new effect when ownership arrives.
        if (asAbortSignal(invocationContext.signal)?.aborted) return cancelledBeforeDispatch(name);
        return invocationContext.mutationFence ? await runWithMutationFence(
            invocationContext.mutationFence,
            () => tool.handler(finalArgs, invocationContext),
          )
        : await tool.handler(finalArgs, invocationContext);
      };
      const result = await runWithSnapshotInvocation({ toolUseId: ctx.currentToolUseId, toolName: name }, invoke);
      notify(result);
      if (result.effectOutcome === 'unknown') ctx.toolCallLedger?.markOutcomeUnknown(name);
      if (ctx.toolCallLedger?.outcomeUnknownTool && result.effectOutcome !== 'unknown') {
        return unknownToolOutcome(`A nested tool outcome is unresolved: ${ctx.toolCallLedger.outcomeUnknownTool}. Reconcile before retrying.`);
      }
      return result;
    } catch (e) {
      notify?.({ isError: true });
      if (isUncertainToolOutcomeError(e)) {
        ctx.toolCallLedger?.markOutcomeUnknown(name);
        return unknownToolOutcome(e.message);
      }
      const msg = e instanceof Error ? e.message : String(e);
      return {
        content: `Tool '${name}' failed: ${msg}`,
        isError: true,
        error: {
          code: 'TOOL_HANDLER_EXCEPTION',
          kind: 'internal',
          retryable: false,
          suggestedAction: 'Inspect the tool error and change approach; do not repeat blindly.',
        },
      };
    }
  }
}

function cancelledBeforeDispatch(name: string): ToolResult {
  return {
    content: `Tool '${name}' was cancelled before its handler started.`,
    isError: true,
    error: { code: 'TOOL_DISPATCH_CANCELLED', kind: 'cancelled', retryable: false,
      suggestedAction: 'Wait for an explicit continuation before starting another invocation.' },
    guardVerdict: { action: 'block', reason: 'tool-dispatch-cancelled', refusalKind: 'abort',
      shouldReflect: false, affectsFailureStreak: false },
  };
}
