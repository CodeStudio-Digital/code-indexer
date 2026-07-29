import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import type {
  CoderTool,
  ToolContext,
  ToolResult,
  ToolSourceTruncation,
} from '@mcp/code-agent/core/tool.js';
import type { JsonSchema } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { inferToolErrorInfo } from '@mcp/code-agent/core/tool-error-info.js';
import type { SessionOverlay } from '@mcp/code-agent/overlay/session-overlay.js';
import { getOverlayHandler } from '@mcp/code-agent/overlay/overlay-handlers.js';
import { capFor } from '@mcp/code-agent/core/runner/output-caps.js';
import { capToolContent } from '@mcp/code-agent/core/runner/pure-helpers.js';
import { normalizeSourceTruncations } from '@mcp/code-agent/core/runner/tool-output-telemetry.js';

const READ_FILE_HARD_MAX = Number(process.env.CODER_READ_FILE_HARD_MAX ?? 800);
const MCP_PATHOLOGICAL_OUTPUT_CHARS = Number(
  process.env.CODER_MCP_PATHOLOGICAL_OUTPUT_CHARS ?? 8_000_000,
);
const MCP_PATHOLOGICAL_STORE_MAX_CHARS = Number(
  process.env.CODER_MCP_PATHOLOGICAL_STORE_MAX_CHARS ?? 32_000_000,
);
/**
 * "Unrestricted tool output" overrides — picked when the active session has
 * `unrestricted_tool_output = 1`. Deliberately not Infinity so the cap arithmetic
 * keeps working on pathological outputs. Auto-compaction in the runner still
 * runs above PRUNE_MINIMUM, so this is not a context-window bypass.
 */
const UNRESTRICTED_READ_FILE_HARD_MAX = Number(
  process.env.CODER_UNRESTRICTED_READ_FILE_HARD_MAX ?? 5_000,
);

function loadDisabledTools(): Set<string> {
  const raw = process.env.CODER_DISABLED_MCP_TOOLS;
  if (!raw) return new Set();
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

const TERSE_TOOLS = process.env.CODER_TERSE_TOOLS === '1';

function terseDescription(desc: string): string {
  if (!TERSE_TOOLS || desc.length <= 150) return desc;
  // Keep the first sentence (or 150 chars).
  const firstStop = desc.search(/[.\n]/);
  if (firstStop > 0 && firstStop <= 150) return desc.slice(0, firstStop + 1).trim();
  return desc.slice(0, 150).trim() + '…';
}

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

/** Last-resort guard for a broken/hostile MCP server. */
function guardPathologicalMcpOutputDetailed(
  text: string,
  ctx: ToolContext,
  pathologicalCap = MCP_PATHOLOGICAL_OUTPUT_CHARS,
): { content: string; sourceTruncations?: ToolSourceTruncation[] } {
  const guardCap = Number.isFinite(pathologicalCap) && pathologicalCap > 0
    ? Math.floor(pathologicalCap)
    : 8_000_000;
  if (text.length <= guardCap) return { content: text };
  const outputId = text.length <= MCP_PATHOLOGICAL_STORE_MAX_CHARS
    ? ctx.toolOutputStore?.put(text) ?? undefined
    : undefined;
  const contextualCap = ctx.toolOutputInlineCap;
  const inlineCap = Math.max(1, Math.min(
    guardCap,
    typeof contextualCap === 'number' && Number.isFinite(contextualCap) && contextualCap > 0
      ? Math.floor(contextualCap)
      : guardCap,
  ));
  const content = capToolContent(
    text,
    inlineCap,
    outputId,
    'mcp_pathological_output',
    'head_tail',
    'output_store',
    text.length,
  ).content;
  return {
    content,
    sourceTruncations: [{
      technique: 'mcp-pathological-guard',
      inputSize: text.length,
      outputSize: content.length,
      unit: 'chars',
      recoverable: !!outputId,
      ...(outputId ? { outputId } : {}),
    }],
  };
}

export function guardPathologicalMcpOutput(
  text: string,
  ctx: ToolContext,
  pathologicalCap = MCP_PATHOLOGICAL_OUTPUT_CHARS,
): string {
  return guardPathologicalMcpOutputDetailed(text, ctx, pathologicalCap).content;
}

function guardMcpToolResult(
  result: ToolResult,
  ctx: ToolContext,
  additional: ToolSourceTruncation[] = [],
): ToolResult {
  const guarded = guardPathologicalMcpOutputDetailed(result.content, ctx);
  const sourceTruncations = [
    ...(result.sourceTruncations ?? []),
    ...additional,
    ...(guarded.sourceTruncations ?? []),
  ];
  return {
    ...result,
    content: guarded.content,
    ...(sourceTruncations.length > 0 ? { sourceTruncations } : {}),
  };
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

  async connect(serverScriptPath?: string): Promise<void> {
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
    this.client = new Client({ name: 'coder-agent', version: '0.1.0' }, { capabilities: {} });
    await this.client.connect(this.transport);
  }

  async listTools(ctx: {
    projectName: string;
    projectRoot?: string;
    overlay?: SessionOverlay;
  }): Promise<CoderTool[]> {
    if (!this.client) throw new Error('McpToolBridge not connected');
    const res = await this.client.listTools();

    const disabled = loadDisabledTools();

    // Sort by name so the tools array is bit-stable across sessions — critical
    // for prompt caching (ZAI/GLM auto-cache and Anthropic ephemeral cache both
    // require an identical prefix to hit).
    const sortedTools = [...res.tools]
      .filter((t) => !disabled.has(t.name))
      .sort((a, b) => a.name.localeCompare(b.name));

    return sortedTools.map((t): CoderTool => {
      const schema = (t.inputSchema ?? { type: 'object', properties: {} }) as unknown as JsonSchema;
      const hasProjectName = schemaHasProperty(schema, 'project_name');
      const publicSchema = stripInjectedProjectName(schema);

      const overlayHandler = getOverlayHandler(t.name);

      return {
        name: `mcp__${t.name}`,
        description: terseDescription(t.description ?? ''),
        parameters: publicSchema,
        source: 'mcp',
        handler: async (args: Record<string, unknown>, toolCtx: ToolContext): Promise<ToolResult> => {
          if (!this.client) {
            return err('MCP client disconnected', {
              code: 'MCP_DISCONNECTED',
              kind: 'network',
              retryable: true,
              suggestedAction: 'Reconnect the MCP server before retrying.',
            });
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
          let mcpText: string;
          let mcpSourceTruncations: ToolSourceTruncation[] = [];
          try {
            const result = await this.client.callTool({ name: t.name, arguments: finalArgs });
            const text = (result.content as Array<{ type: string; text?: string }> | undefined)
              ?.filter((c) => c.type === 'text' && typeof c.text === 'string')
              .map((c) => c.text!)
              .join('\n') ?? '';
            if (result.isError) {
              const message = text || 'MCP tool returned error';
              return err(message, inferToolErrorInfo(`mcp__${t.name}`, message));
            }
            mcpText = text;
            mcpSourceTruncations = normalizeSourceTruncations(
              (result as { _meta?: { sourceTruncations?: unknown } })._meta?.sourceTruncations,
            ).map(({ outputId: _remoteOutputId, ...source }) => source);
          } catch (e) {
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
            return guardMcpToolResult(merged, toolCtx, mcpSourceTruncations);
          }
          // Do not cut here: the runner must see the complete raw payload so
          // it can spill it to ToolOutputStore before semantic reduction and
          // the context-relative fail-safe cap. A bridge-level head cut made
          // the omitted portion permanently unrecoverable.
          return guardMcpToolResult(ok(clampNote + mcpText), toolCtx, mcpSourceTruncations);
        },
      };
    });
  }

  /**
   * Return the list of static resources exposed by the connected MCP server,
   * plus any URI templates. Falls through to an empty list when the server
   * advertises no resources or when the call fails (e.g., older servers
   * without resource support — the SDK throws "Method not found").
   */
  async listResources(): Promise<{
    resources: Array<{ uri: string; name: string; description?: string; mimeType?: string }>;
    templates: Array<{ uriTemplate: string; name: string; description?: string; mimeType?: string }>;
  }> {
    if (!this.client) throw new Error('McpToolBridge not connected');
    let resources: Array<{ uri: string; name: string; description?: string; mimeType?: string }> = [];
    let templates: Array<{ uriTemplate: string; name: string; description?: string; mimeType?: string }> = [];
    try {
      const res = await this.client.listResources();
      resources = (res.resources ?? []).map((r) => ({
        uri: r.uri, name: r.name, description: r.description, mimeType: r.mimeType,
      }));
    } catch {
      // No resource capability — leave empty.
    }
    try {
      const res = await this.client.listResourceTemplates();
      templates = (res.resourceTemplates ?? []).map((t) => ({
        uriTemplate: t.uriTemplate, name: t.name, description: t.description, mimeType: t.mimeType,
      }));
    } catch {
      // No templates — leave empty.
    }
    return { resources, templates };
  }

  /**
   * Read a resource by URI. Returns the concatenated text contents (binary
   * `blob` resources are reported as a placeholder line so the agent can see
   * they exist without us trying to render them as text).
   */
  async readResource(uri: string): Promise<{ contents: string; mimeType?: string }> {
    if (!this.client) throw new Error('McpToolBridge not connected');
    const res = await this.client.readResource({ uri });
    const parts: string[] = [];
    let mimeType: string | undefined;
    for (const c of res.contents ?? []) {
      mimeType = mimeType ?? (c as { mimeType?: string }).mimeType;
      if ('text' in c && typeof c.text === 'string') {
        parts.push(c.text);
      } else if ('blob' in c) {
        const blob = (c as { blob: string }).blob;
        parts.push(`[binary resource: ${blob.length} base64 chars, mimeType=${mimeType ?? 'unknown'}]`);
      }
    }
    return { contents: parts.join('\n'), mimeType };
  }

  async close(): Promise<void> {
    try {
      await this.client?.close();
    } catch {
      // ignore
    }
    this.client = null;
    this.transport = null;
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
