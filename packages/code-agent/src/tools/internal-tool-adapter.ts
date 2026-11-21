import { guardMcpToolResult } from './mcp-output-guard.js';
import { mcpResultToToolResult } from './mcp-result.js';
import { withMcpReadKnowledge } from './mcp-read-knowledge.js';
import type { CoderTool, JsonSchema, ToolContext, ToolResult, ToolSourceTruncation } from '@mcp/code-agent/core/tool.js';
import { ok, err, unknownToolOutcome } from '@mcp/code-agent/core/tool.js';
import { asAbortSignal } from '@mcp/code-agent/core/abort-signal.js';
import { internalMcpContract } from './internal-mcp-contract.js';
import { invokeOwnedDocumentExport } from './owned-document-export.js';
import { invokeOwnedProjectIndex } from './owned-project-index.js';
import { invokeOwnedMemorySave } from './owned-memory-save.js';
import { inferToolErrorInfo } from '@mcp/code-agent/core/tool-error-info.js';
import type { SessionOverlay } from '@mcp/code-agent/overlay/session-overlay.js';
import { getOverlayHandler } from '@mcp/code-agent/overlay/overlay-handlers.js';
import { capFor } from '@mcp/code-agent/core/runner/output-caps.js';
import { stripInjectedProjectName } from './internal-tool-schema.js';
import { INDEX_TOOLS_PROVIDER_ID } from '@mcp/code-agent/core/index-tool-identity.js';

const READ_FILE_HARD_MAX = 800;
/**
 * "Unrestricted tool output" overrides — picked when the active session has
 * `unrestricted_tool_output = 1`. Deliberately not Infinity so the cap arithmetic
 * keeps working on pathological outputs. Context-window compaction in the
 * runner still applies, so this is not a context-window bypass.
 */
const UNRESTRICTED_READ_FILE_HARD_MAX = 5_000;

/** The project one tool instance is bound to (primary or a prefixed secondary). */
export interface InternalToolBinding {
  projectName: string;
  projectRoot?: string;
  overlay?: SessionOverlay;
}

/** A first-party index tool as the server publishes it. */
export interface InternalToolEntry {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

type CallResult = Parameters<typeof mcpResultToToolResult>[0];
type Dispatch = (finalArgs: Record<string, unknown>, signal: AbortSignal | undefined) => Promise<CallResult>;

/**
 * Where a call goes after the shared pre-processing. `prepare` failures happen
 * before dispatch; a rejected dispatch is a lost call (unknown outcome for
 * mutations). The in-process route (native-index-tools.ts) implements it.
 */
export interface InternalToolRoute {
  prepare(name: string, signal: AbortSignal | undefined): Promise<Dispatch>;
}

/** Drop `__*` keys a model may send; only the adapter injects internal arguments. */
function withoutInternalArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args ?? {}).filter(([key]) => !key.startsWith('__')));
}

function schemaHasProperty(schema: JsonSchema, property: string): boolean {
  if (typeof schema !== 'object' || schema === null) return false;
  const props = (schema as { properties?: unknown }).properties;
  return typeof props === 'object' && props !== null && !Array.isArray(props) && property in props;
}

/** The CoderTool for one first-party index tool; only `provenanceRef` tells routes apart. */
export function internalToolDefinition(
  t: InternalToolEntry,
  ctx: InternalToolBinding,
  provenanceRef: string,
  route: InternalToolRoute,
): CoderTool {
  const schema = (t.inputSchema ?? { type: 'object', properties: {} }) as unknown as JsonSchema;
  const hasProjectName = schemaHasProperty(schema, 'project_name');
  const publicSchema = stripInjectedProjectName(schema);
  const overlayHandler = getOverlayHandler(t.name);
  const contract = internalMcpContract(t.name);

  return {
    name: `mcp__${t.name}`,
    description: t.description ?? '',
    parameters: publicSchema,
    // In-process first-party tools: native. What they kept from the MCP
    // route (timeout, Ultra isolation, published labels) is explicit; see
    // core/index-tool-identity.ts.
    source: 'native',
    ...contract,
    capabilityProvenance: {
      kind: 'native',
      providerId: INDEX_TOOLS_PROVIDER_ID,
      provenanceRef,
    },
    handler: withMcpReadKnowledge(t.name, (toolCtx) => ctx.projectRoot ?? toolCtx.cwd,
      async (modelArgs: Record<string, unknown>, toolCtx: ToolContext): Promise<ToolResult> => {
        // `__*` keys are internal to this adapter; the model never supplies them.
        const args = withoutInternalArgs(modelArgs);
        const signal = asAbortSignal(toolCtx.signal);
        if (signal?.aborted) return err('MCP call cancelled before dispatch.', {
          code: 'MCP_CALL_CANCELLED', kind: 'cancelled', retryable: false,
        });
        if (t.name === 'export_docs' && toolCtx.mutationFence?.mode === 'enforce') {
          return guardMcpToolResult(await invokeOwnedDocumentExport(args, toolCtx), toolCtx);
        }
        if (t.name === 'index_project' && toolCtx.mutationFence?.mode === 'enforce') {
          return guardMcpToolResult(await invokeOwnedProjectIndex(args, toolCtx), toolCtx);
        }
        if (t.name === 'save_memory' && toolCtx.mutationFence?.mode === 'enforce') {
          return guardMcpToolResult(await invokeOwnedMemorySave(args, toolCtx), toolCtx);
        }
        const overlay = ctx.overlay ?? toolCtx.overlay;
        const projectRoot = ctx.projectRoot ?? toolCtx.cwd;
        const finalArgs = { ...args };
        if (hasProjectName) {
          finalArgs.project_name = ctx.projectName;
        }
        if (t.name === 'search' || t.name === 'semantic_neighbors') {
          if (toolCtx.sessionId) {
            finalArgs.__mcp_session_id = toolCtx.sessionId;
          }
          if (toolCtx.companyContext?.companySessionId) {
            finalArgs.__mcp_company_session_id =
              toolCtx.companyContext.companySessionId;
          }
        }
        // Clamp read_file.max_lines to a hard absolute maximum and tell
        // the caller via a tiny synthetic prefix on the response when the
        // clamp actually kicks in. Default (no max_lines) goes to the
        // server-side default (400) — we only clamp when the caller
        // explicitly asked for more than HARD_MAX. The ceiling scales with
        // the session's tool-output cap LEVEL (READ_FILE_HARD_MAX=800 base →
        // up to UNRESTRICTED_READ_FILE_HARD_MAX=5 000 lines at `max`, 20 000 at `ultra`).
        let clampNote = '';
        const effectiveReadFileHardMax = capFor(
          toolCtx.toolOutputCapLevel ?? 'economic',
          READ_FILE_HARD_MAX,
          UNRESTRICTED_READ_FILE_HARD_MAX,
        );
        if (t.name === 'read_file') {
          const requested = typeof finalArgs.max_lines === 'number' ? finalArgs.max_lines : null;
          if (requested != null && requested > effectiveReadFileHardMax) {
            finalArgs.max_lines = effectiveReadFileHardMax;
            // Argument normalization is not itself proof that the source was
            // truncated: a 20-line file still fits after a 5,000→800 clamp.
            // The MCP producer supplies structured omission metadata only
            // when lines are actually left out.
            clampNote = `[note: max_lines clamped from ${requested} to ${effectiveReadFileHardMax} by bridge]\n`;
          }
        }

        // 1. Session overlay: internal arguments for files touched in this session.
        if (overlay && overlayHandler?.internalArgs) {
          Object.assign(finalArgs, overlayHandler.internalArgs(finalArgs, overlay));
        }

        // 2. Delegate to the index tool (in-process port)
        let dispatch: Dispatch;
        try { dispatch = await route.prepare(t.name, signal); }
        catch (error) {
          return err(`MCP preparation failed before dispatch: ${error instanceof Error ? error.message : error}`, {
            code: signal?.aborted ? 'MCP_CALL_CANCELLED' : 'MCP_CONNECT_FAILED',
            kind: signal?.aborted ? 'cancelled' : 'network', retryable: !signal?.aborted,
          });
        }
        let mcpText: string;
        let mcpStructuredData: unknown;
        let mcpAttachments: ToolResult['extraUserBlocks'];
        let mcpSourceTruncations: ToolSourceTruncation[] = [];
        try {
          if (t.name === 'list_models' && args.view == null && args.provider == null && args.live !== true) {
            const selected = await toolCtx.childChats?.catalogSelection?.();
            if (selected) {
              finalArgs.provider = selected.provider;
              if (args.query == null && selected.query) { finalArgs.query = selected.query; finalArgs.match = 'name'; }
            }
          }
          const result = await dispatch(finalArgs, signal);
          const adapted = mcpResultToToolResult(result, t.name);
          const text = adapted.content;
          mcpStructuredData = adapted.structuredData;
          mcpAttachments = adapted.extraUserBlocks;
          mcpSourceTruncations = adapted.sourceTruncations ?? [];
          if (contract.mutates && (result._meta as { effectOutcome?: unknown } | undefined)?.effectOutcome === 'unknown') {
            return unknownToolOutcome(text || `MCP tool '${t.name}' lost effect confirmation at its owner.`);
          }
          if (result.isError) {
            const message = text || 'MCP tool returned error';
            return guardMcpToolResult({ ...adapted, ...err(message, inferToolErrorInfo(`mcp__${t.name}`, message)) }, toolCtx);
          }
          mcpText = text;
        } catch (e) {
          if (contract.mutates) return unknownToolOutcome(
            `MCP tool '${t.name}' lost confirmation after dispatch. Its effect may have completed. `
            + 'Reconcile the original operation before authorizing another mutation.',
          );
          if (signal?.aborted) return err(`MCP read '${t.name}' was cancelled.`, {
            code: 'MCP_CALL_CANCELLED', kind: 'cancelled', retryable: false,
          });
          return err(`MCP tool '${t.name}' failed: ${e instanceof Error ? e.message : String(e)}`, {
            code: 'MCP_CALL_FAILED',
            kind: 'network',
            retryable: true,
            suggestedAction: 'Verify the MCP server connection and retry when it is healthy.',
          });
        }

        // 3. Post-process — merge overlay data into the MCP output
        if (overlay && overlayHandler?.postProcess) {
          const merged = overlayHandler.postProcess(clampNote + mcpText, args, overlay, projectRoot);
          return guardMcpToolResult({ ...merged,
            ...(mcpAttachments?.length ? { extraUserBlocks: mcpAttachments } : {}),
            ...(mcpStructuredData !== undefined ? { structuredData: { source: mcpStructuredData, overlayApplied: true, text: merged.content } } : {}) }, toolCtx, mcpSourceTruncations);
        }
        // Do not cut here: the runner must see the complete raw payload so
        // it can spill it to ToolOutputStore before semantic reduction and
        // the context-relative fail-safe cap. A bridge-level head cut made
        // the omitted portion permanently unrecoverable.
        return guardMcpToolResult({ ...ok(clampNote + mcpText),
          ...(mcpAttachments?.length ? { extraUserBlocks: mcpAttachments } : {}),
          ...(mcpStructuredData !== undefined ? { structuredData: mcpStructuredData } : {}) }, toolCtx, mcpSourceTruncations);
      }),
  };
}
