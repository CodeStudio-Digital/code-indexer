import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import type { CoderTool, ToolContext, ToolResult } from '../core/tool.js';
import type { JsonSchema } from '../core/tool.js';
import { ok, err } from '../core/tool.js';
import type { SessionOverlay } from '../overlay/session-overlay.js';
import { getOverlayHandler } from '../overlay/overlay-handlers.js';

/**
 * Default `max_tokens` injected by the bridge for verbose MCP tools when the
 * model omits the parameter. Without these, tools like `get_project_context`
 * return unbounded content (truncateToTokens in src/mcp/server.ts is a no-op
 * when max_tokens is undefined). Override with CODER_MCP_DEFAULT_MAX_TOKENS
 * (JSON object: {"tool_name": number}).
 */
const DEFAULT_MAX_TOKENS_BUILTIN: Record<string, number> = {
  get_project_overview: 2000,
  get_project_context: 3000,
  get_architecture: 1500,
  get_project_stats: 1000,
  list_snapshots: 2000,
  search_concepts: 1500,
  get_context_for: 2500,
  query_snapshots: 1500,
};

function loadDefaultMaxTokens(): Record<string, number> {
  const raw = process.env.CODER_MCP_DEFAULT_MAX_TOKENS;
  if (!raw) return DEFAULT_MAX_TOKENS_BUILTIN;
  try {
    const parsed = JSON.parse(raw) as Record<string, number>;
    return { ...DEFAULT_MAX_TOKENS_BUILTIN, ...parsed };
  } catch {
    return DEFAULT_MAX_TOKENS_BUILTIN;
  }
}

const MCP_OUTPUT_HARD_CAP = Number(process.env.CODER_MCP_OUTPUT_HARD_CAP ?? 16_000);
const READ_FILE_HARD_MAX = Number(process.env.CODER_READ_FILE_HARD_MAX ?? 800);

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
    this.transport = new StdioClientTransport({
      command,
      args,
      env: process.env as Record<string, string>,
    });
    this.client = new Client({ name: 'coder-agent', version: '0.1.0' }, { capabilities: {} });
    await this.client.connect(this.transport);
  }

  async listTools(ctx: { projectName: string; overlay?: SessionOverlay }): Promise<CoderTool[]> {
    if (!this.client) throw new Error('McpToolBridge not connected');
    const res = await this.client.listTools();

    const disabled = loadDisabledTools();
    const defaultMaxTokens = loadDefaultMaxTokens();

    // Sort by name so the tools array is bit-stable across sessions — critical
    // for prompt caching (ZAI/GLM auto-cache and Anthropic ephemeral cache both
    // require an identical prefix to hit).
    const sortedTools = [...res.tools]
      .filter((t) => !disabled.has(t.name))
      .sort((a, b) => a.name.localeCompare(b.name));

    return sortedTools.map((t): CoderTool => {
      const schema = (t.inputSchema ?? { type: 'object', properties: {} }) as unknown as JsonSchema;
      const hasProjectName =
        typeof schema === 'object' &&
        schema !== null &&
        typeof schema.properties === 'object' &&
        schema.properties !== null &&
        'project_name' in schema.properties;
      const hasMaxTokens =
        typeof schema === 'object' &&
        schema !== null &&
        typeof schema.properties === 'object' &&
        schema.properties !== null &&
        'max_tokens' in schema.properties;

      const overlayHandler = getOverlayHandler(t.name);
      const builtinDefault = defaultMaxTokens[t.name];

      return {
        name: `mcp__${t.name}`,
        description: terseDescription(t.description ?? ''),
        parameters: schema,
        source: 'mcp',
        handler: async (args: Record<string, unknown>, toolCtx: ToolContext): Promise<ToolResult> => {
          if (!this.client) return err('MCP client disconnected');

          const overlay = ctx.overlay ?? toolCtx.overlay;
          const projectRoot = toolCtx.cwd;

          // 1. Short-circuit via overlay when possible (dirty files skip MCP)
          if (overlay && overlayHandler?.pre) {
            const local = overlayHandler.pre(args, overlay, projectRoot);
            if (local) return capResult(local);
          }

          // 2. Delegate to the real MCP server
          const finalArgs = { ...args };
          if (hasProjectName && finalArgs.project_name === undefined) {
            finalArgs.project_name = ctx.projectName;
          }
          // Inject default max_tokens for verbose tools when the model omits it.
          if (hasMaxTokens && finalArgs.max_tokens === undefined && builtinDefault) {
            finalArgs.max_tokens = builtinDefault;
          }
          // Clamp read_file.max_lines to a hard absolute maximum and tell
          // the caller via a tiny synthetic prefix on the response when the
          // clamp actually kicks in. Default (no max_lines) goes to the
          // server-side default (400) — we only clamp when the caller
          // explicitly asked for more than HARD_MAX.
          let clampNote = '';
          if (t.name === 'read_file') {
            const requested = typeof finalArgs.max_lines === 'number' ? finalArgs.max_lines : null;
            if (requested != null && requested > READ_FILE_HARD_MAX) {
              finalArgs.max_lines = READ_FILE_HARD_MAX;
              clampNote = `[clamped from ${requested} to ${READ_FILE_HARD_MAX} lines — bridge cap]\n`;
            }
          }
          let mcpText: string;
          try {
            const result = await this.client.callTool({ name: t.name, arguments: finalArgs });
            const text = (result.content as Array<{ type: string; text?: string }> | undefined)
              ?.filter((c) => c.type === 'text' && typeof c.text === 'string')
              .map((c) => c.text!)
              .join('\n') ?? '';
            if (result.isError) return err(text || 'MCP tool returned error');
            mcpText = text;
          } catch (e) {
            return err(`MCP tool '${t.name}' failed: ${e instanceof Error ? e.message : String(e)}`);
          }

          // 3. Post-process — merge overlay data into the MCP output
          if (overlay && overlayHandler?.postProcess) {
            return capResult(overlayHandler.postProcess(clampNote + mcpText, args, overlay, projectRoot));
          }
          return ok(applyOutputCap(clampNote + mcpText));
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
 * Hard-cap the textual output of any MCP tool. Prevents a single rogue call
 * (or one where the model forgot to pass max_tokens) from injecting tens of
 * thousands of tokens into the conversation history. The marker is
 * deterministic so identical truncations preserve prefix-cache stability.
 */
function applyOutputCap(text: string): string {
  if (text.length <= MCP_OUTPUT_HARD_CAP) return text;
  return (
    text.slice(0, MCP_OUTPUT_HARD_CAP) +
    `\n\n[output truncated at ${MCP_OUTPUT_HARD_CAP} chars — refine your query, use max_tokens/limit, or paginate via offset]`
  );
}

/** Apply applyOutputCap to a ToolResult, preserving isError. */
function capResult(r: ToolResult): ToolResult {
  return { ...r, content: applyOutputCap(r.content) };
}

/**
 * Locate the compiled MCP server script. In dev (tsx) the dist may not exist
 * yet — fall back to the source path which tsx can run.
 */
function findServerScript(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Walk up looking for either dist/apps/mcp-server/index.js or src/apps/mcp-server/index.ts.
  // `here` is dist/core/coder/tools (built) or src/core/coder/tools (tsx dev) —
  // three levels up lands in dist/ or src/ respectively.
  const candidates = [
    resolve(here, '../../../apps/mcp-server/index.js'),
    resolve(here, '../../../apps/mcp-server/index.ts'),
    resolve(here, '../../../../dist/apps/mcp-server/index.js'),
    resolve(here, '../../../../src/apps/mcp-server/index.ts'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}
