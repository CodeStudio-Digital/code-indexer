import { guardMcpToolResult } from './mcp-output-guard.js';
import { mcpResultToToolResult } from './mcp-result.js';
export { guardPathologicalMcpOutput } from './mcp-output-guard.js';
import { listMcpResourcePage, readMcpResource } from './mcp-resource-bridge.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { DeferredMcpValidator } from './deferred-mcp-validator.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve, dirname } from 'node:path';
import { withMcpReadKnowledge } from './mcp-read-knowledge.js';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type { CoderTool, ToolContext, ToolResult, ToolSourceTruncation } from '@mcp/code-agent/core/tool.js';
import type { JsonSchema } from '@mcp/code-agent/core/tool.js';
import { ok, err, unknownToolOutcome } from '@mcp/code-agent/core/tool.js';
import { okStructured } from '@mcp/code-agent/core/model-output.js';
import { asAbortSignal } from '@mcp/code-agent/core/abort-signal.js';
import { internalMcpContract } from './internal-mcp-contract.js';
import { INTERNAL_MCP_CATALOG } from './generated/internal-mcp-catalog.js';
import { invokeOwnedDocumentExport } from './owned-document-export.js';
import { invokeOwnedProjectIndex } from './owned-project-index.js';
import { invokeOwnedMemorySave } from './owned-memory-save.js';
import { AGENT_READ_NAMES, type AgentReadName } from '../ports/agent-read-port.js';
import { inferToolErrorInfo } from '@mcp/code-agent/core/tool-error-info.js';
import type { SessionOverlay } from '@mcp/code-agent/overlay/session-overlay.js';
import { getOverlayHandler } from '@mcp/code-agent/overlay/overlay-handlers.js';
import { capFor } from '@mcp/code-agent/core/runner/output-caps.js';

import { normalizeSourceTruncations } from '@mcp/code-agent/core/runner/tool-output-telemetry.js';

const READ_FILE_HARD_MAX = 800;
/**
 * "Unrestricted tool output" overrides — picked when the active session has
 * `unrestricted_tool_output = 1`. Deliberately not Infinity so the cap arithmetic
 * keeps working on pathological outputs. Auto-compaction in the runner still
 * runs above PRUNE_MINIMUM, so this is not a context-window bypass.
 */
const UNRESTRICTED_READ_FILE_HARD_MAX = 5_000;

function schemaProperties(schema: JsonSchema): Record<string, unknown> | null {
  if (typeof schema !== 'object' || schema === null) return null;
  const props = (schema as { properties?: unknown }).properties;
  return typeof props === 'object' && props !== null && !Array.isArray(props)
    ? props as Record<string, unknown>
    : null;
}

function schemaHasProperty(schema: JsonSchema, property: string): boolean {
  const props = schemaProperties(schema);
  return props ? property in props : false;
}

/**
 * `project_name` is a bridge concern, not a model concern. The MCP server still
 * requires it, but the bridge knows the exact project behind this tool instance
 * and injects it at call time. Hiding the field prevents weak models/subagents
 * from sending placeholders like `project` or `""`. In global sessions each
 * bridge instance is bound to one explicit linked real project.
 */
export function stripInjectedProjectName(schema: JsonSchema): JsonSchema {
  const props = schemaProperties(schema);
  if (!props || !('project_name' in props)) return schema;

  const publicProps = { ...props };
  delete publicProps.project_name;

  const publicSchema: Record<string, unknown> = {
    ...(schema as unknown as Record<string, unknown>),
    properties: publicProps,
  };

  const required = (schema as { required?: unknown }).required;
  if (Array.isArray(required)) {
    const publicRequired = required.filter((key) => key !== 'project_name');
    if (publicRequired.length > 0) {
      publicSchema.required = publicRequired;
    } else {
      delete publicSchema.required;
    }
  }

  return publicSchema as unknown as JsonSchema;
}

/**
 * Spawns the indexer's MCP server as a stdio subprocess and converts each
 * exposed tool into a CoderTool prefixed with `mcp__`. Tool calls are
 * forwarded to the MCP client; project_name is auto-injected when the schema
 * declares it, so the LLM never has to repeat it.
 */
export class McpToolBridge {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private connecting: Promise<void> | null = null;
  private closed = false;
  private readonly lifetime = new AbortController();

  constructor(private readonly options: { deferConnection?: boolean } = {}) {}

  connect(serverScriptPath?: string): Promise<void> {
    if (this.closed) return Promise.reject(new Error('MCP bridge is closed'));
    if (this.connecting) return this.connecting;
    if (this.client) return Promise.resolve();
    const pending = this.openConnection(serverScriptPath);
    this.connecting = pending;
    void pending.finally(() => { if (this.connecting === pending) this.connecting = null; }).catch(() => undefined);
    return pending;
  }

  private async openConnection(serverScriptPath?: string): Promise<void> {
    const scriptPath = serverScriptPath ?? findServerScript();
    // When dev:server runs via `tsx watch`, findServerScript() resolves to
    // src/apps/mcp-server/index.ts. Spawning that with plain `node` fails
    // because Node can't run .ts files AND can't rewrite the `./context.js`
    // specifiers to .ts. Detect the .ts case and spawn via the tsx CLI so
    // the subprocess gets the same resolver the parent is using.
    const isTypeScript = scriptPath.endsWith('.ts');
    const { command, args } = isTypeScript
      ? { command: process.execPath, args: ['--import', 'tsx/esm', scriptPath] }
      : { command: process.execPath, args: [scriptPath] };

    // Inside Electron, `process.execPath` is the electron binary — NOT a
    // Node interpreter. Spawning it without the magic env var below tries
    // to launch a new Electron app (full Chromium boot, never speaks the
    // MCP stdio handshake), which surfaces as the bridge timing out
    // ("MCP error -32001: Request timed out"). `ELECTRON_RUN_AS_NODE=1`
    // tells the electron binary to skip its app initialisation and behave
    // as a plain Node executable, which is what every other tool that
    // shells out from Electron uses. No-op in regular Node (the var is
    // ignored).
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    if (process.versions.electron) {
      env.ELECTRON_RUN_AS_NODE = '1';
    }

    this.transport = new StdioClientTransport({
      command,
      args,
      env,
    });
    this.client = new Client({ name: 'coder-agent', version: '0.1.0' }, {
      capabilities: {}, jsonSchemaValidator: new DeferredMcpValidator(),
    });
    const client = this.client;
    try {
      await client.connect(this.transport, { signal: this.lifetime.signal, timeout: 10_000 });
      this.lifetime.signal.throwIfAborted();
      if (this.options.deferConnection) {
        const live = await client.listTools(undefined, { signal: this.lifetime.signal, timeout: 10_000 });
        const metadata = live.tools.map(({ name, description, inputSchema }) => ({ name, description: description ?? '', inputSchema }))
          .sort((a, b) => a.name.localeCompare(b.name));
        if (!isDeepStrictEqual(metadata, INTERNAL_MCP_CATALOG)) throw new Error('Built-in MCP catalog differs from its prepared snapshot');
      }
    } catch (cause) {
      await client.close().catch(() => undefined);
      if (this.client === client) { this.client = null; this.transport = null; }
      throw cause;
    }
  }

  private async readyClient(signal?: AbortSignal): Promise<Client> {
    signal?.throwIfAborted();
    if (this.closed) throw new Error('MCP bridge is closed');
    if (this.options.deferConnection) {
      const pending = this.connect();
      let aborted: (() => void) | undefined;
      try {
        await (signal ? Promise.race([pending, new Promise<never>((_resolve, reject) => {
          aborted = () => reject(signal.reason ?? new Error('MCP preparation cancelled'));
          signal.addEventListener('abort', aborted, { once: true });
          if (signal.aborted) aborted();
        })]) : pending);
      } finally { if (aborted) signal?.removeEventListener('abort', aborted); }
    }
    signal?.throwIfAborted();
    if (!this.client || this.closed) throw new Error('MCP client disconnected');
    return this.client;
  }

  async listTools(ctx: {
    projectName: string;
    projectRoot?: string;
    overlay?: SessionOverlay;
  }): Promise<CoderTool[]> {
    if (this.closed) throw new Error('MCP bridge is closed');
    if (!this.options.deferConnection && !this.client) throw new Error('McpToolBridge not connected');
    const res = this.options.deferConnection
      ? { tools: structuredClone(INTERNAL_MCP_CATALOG) }
      : await this.client!.listTools();

    // Sort by name so the tools array is bit-stable across sessions — critical
    // for prompt caching (ZAI/GLM auto-cache and Anthropic ephemeral cache both
    // require an identical prefix to hit).
    const sortedTools = [...res.tools]
      .sort((a, b) => a.name.localeCompare(b.name));

    return sortedTools.map((t): CoderTool => {
      const schema = (t.inputSchema ?? { type: 'object', properties: {} }) as unknown as JsonSchema;
      const hasProjectName = schemaHasProperty(schema, 'project_name');
      const publicSchema = stripInjectedProjectName(schema);

      const overlayHandler = getOverlayHandler(t.name);
      const contract = internalMcpContract(t.name);

      return {
        name: `mcp__${t.name}`,
        description: t.description ?? '',
        parameters: publicSchema,
        source: 'mcp',
        ...contract,
        capabilityProvenance: {
          kind: 'mcp_internal',
          providerId: 'code-indexer',
          provenanceRef: 'mcp-internal:code-indexer',
        },
        handler: withMcpReadKnowledge(t.name, (toolCtx) => ctx.projectRoot ?? toolCtx.cwd,
          async (args: Record<string, unknown>, toolCtx: ToolContext): Promise<ToolResult> => {
          if (this.closed) return err('MCP bridge is closed', { code: 'MCP_CLOSED', kind: 'cancelled', retryable: false });
          const signal = asAbortSignal(toolCtx.signal);
          if (signal?.aborted) return err('MCP call cancelled before dispatch.', {
            code: 'MCP_CALL_CANCELLED', kind: 'cancelled', retryable: false,
          });
          if (AGENT_READ_NAMES.includes(t.name as AgentReadName)) {
            if (!toolCtx.agentReads) return err('Agent queries require the current application read port.');
            try {
              const value = await toolCtx.agentReads.read(t.name as AgentReadName, args, signal);
              signal?.throwIfAborted();
              return guardMcpToolResult(okStructured(value), toolCtx);
            } catch (error) { return err(`Agent query failed: ${error instanceof Error ? error.message : error}`); }
          }
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

          // 1. Short-circuit via overlay when possible (dirty files skip MCP).
          // Use the already-clamped args so a dirty file cannot bypass the
          // same read_file line safety boundary as the remote MCP path.
          if (overlay && overlayHandler?.pre) {
            const local = overlayHandler.pre(finalArgs, overlay, projectRoot);
            if (local) {
              return guardMcpToolResult(
                { ...local, content: clampNote + local.content },
                toolCtx,
              );
            }
          }

          // 2. Delegate to the real MCP server
          let client: Client;
          try { client = await this.readyClient(signal); }
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
            const request = { name: t.name, arguments: finalArgs };
            const result = signal
              ? await client.callTool(request, undefined, { signal })
              : await client.callTool(request);
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
    });
  }

  /** Request one bounded, cancellable resource page from the connected server. */
  async listResources(options?: import('./mcp-resource-bridge.js').ResourcePageOptions) {
    return listMcpResourcePage(await this.readyClient(options?.signal), options);
  }

  async readResource(uri: string, signal?: AbortSignal): Promise<{ contents: string; mimeType?: string }> {
    return readMcpResource(await this.readyClient(signal), uri, signal);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.lifetime.abort(new Error('MCP bridge closed'));
    const pending = this.connecting;
    try {
      await this.client?.close();
    } catch {
      // ignore
    }
    this.client = null;
    this.transport = null;
    await pending?.catch(() => undefined);
  }
}

/**
 * Locate the compiled MCP server script. In dev (tsx) the dist may not exist
 * yet — fall back to the source path which tsx can run.
 *
 * Layout possibilities the resolver handles:
 *   - tsx dev:  packages/code-agent/src/tools/mcp-bridge.ts → apps/mcp-server/index.ts
 *     Relative from `here`: ../../../../apps/mcp-server/index.ts
 *   - per-package build: packages/code-agent/dist/tools/mcp-bridge.js → apps/mcp-server/index.js
 *     (apps is sibling of packages/, NOT under each dist).
 *   - root-level dist (legacy):  dist/packages/code-agent/src/tools/mcp-bridge.js
 *
 * Historic NOTE: `@apps/*` is a TYPESCRIPT PATH ALIAS, not a real directory.
 * Earlier versions of this resolver dropped the alias string into a
 * filesystem path which produced a literal `packages/code-agent/@apps/...`
 * and crashed with MODULE_NOT_FOUND. We now resolve to the repo root
 * (apps/ as sibling of packages/) via a robust upward search instead.
 */
function findServerScript(): string {
  const here = dirname(fileURLToPath(import.meta.url));

  // Walk up from `here` looking for a directory that contains BOTH
  // `apps/` and `packages/` — that's the repo root. Stops at the
  // filesystem root if nothing matches.
  let cursor = here;
  let repoRoot: string | null = null;
  for (let i = 0; i < 12; i++) {
    if (existsSync(resolve(cursor, 'apps')) && existsSync(resolve(cursor, 'packages'))) {
      repoRoot = cursor;
      break;
    }
    const parent = resolve(cursor, '..');
    if (parent === cursor) break;
    cursor = parent;
  }

  const candidates: string[] = [];
  if (repoRoot) {
    candidates.push(
      resolve(repoRoot, 'apps/mcp-server/index.ts'),
      resolve(repoRoot, 'apps/mcp-server/index.js'),
      resolve(repoRoot, 'dist/apps/mcp-server/index.js'),
      resolve(repoRoot, 'apps/mcp-server/dist/index.js'),
    );
  }
  // Legacy relative fallbacks, in case the repo layout shifts and the
  // walker doesn't find an `apps/` + `packages/` parent.
  candidates.push(
    resolve(here, '../../../../apps/mcp-server/index.ts'),
    resolve(here, '../../../../apps/mcp-server/index.js'),
  );

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Stable fallback for error messaging.
  return candidates[0];
}
