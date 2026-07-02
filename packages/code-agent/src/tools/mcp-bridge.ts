import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import type { CoderTool, ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import type { JsonSchema } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import type { SessionOverlay } from '@mcp/code-agent/overlay/session-overlay.js';
import { getOverlayHandler } from '@mcp/code-agent/overlay/overlay-handlers.js';
import { truncationMarker } from '@mcp/code-agent/tools/truncation-marker.js';
import { capFor } from '@mcp/code-agent/core/runner/output-caps.js';

/**
 * Default `max_tokens` injected by the bridge for verbose MCP tools when the
 * model omits the parameter. Without these, tools like `get_project_overview`
 * return unbounded content (truncateToTokens in src/mcp/server.ts is a no-op
 * when max_tokens is undefined). Override with CODER_MCP_DEFAULT_MAX_TOKENS
 * (JSON object: {"tool_name": number}).
 */
const DEFAULT_MAX_TOKENS_BUILTIN: Record<string, number> = {
  get_project_overview: 2000,
  search_memory: 1500,
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

// Raised 16k → 200k: this is now only a PATHOLOGICAL guard against multi-MB
// payloads. Normal large arrays flow intact to the runner, which spills the
// original (recoverable via get_tool_output), relevance-ranks via json-crush,
// and applies the fail-safe push-time cap (see finalizeToolResultForBridge).
// Blind head-cutting here used to pre-empt json-crush's full-array ranking.
const MCP_OUTPUT_HARD_CAP = Number(process.env.CODER_MCP_OUTPUT_HARD_CAP ?? 200_000);
const READ_FILE_HARD_MAX = Number(process.env.CODER_READ_FILE_HARD_MAX ?? 800);
/**
 * "Unrestricted tool output" overrides — picked when the active session has
 * `unrestricted_tool_output = 1`. Deliberately not Infinity so the cap arithmetic
 * keeps working on pathological outputs. Auto-compaction in the runner still
 * runs above PRUNE_MINIMUM, so this is not a context-window bypass.
 */
const UNRESTRICTED_MCP_HARD_CAP = Number(
  process.env.CODER_UNRESTRICTED_MCP_HARD_CAP ?? 1_000_000,
);
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
            if (local) return capResult(local, toolCtx);
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
              clampNote = `${truncationMarker(`max_lines clamped from ${requested} to ${effectiveReadFileHardMax}`, 'bridge cap')}\n`;
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
            return capResult(
              overlayHandler.postProcess(clampNote + mcpText, args, overlay, projectRoot),
              toolCtx,
            );
          }
          return ok(applyOutputCap(clampNote + mcpText, toolCtx));
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
 *
 * The cap scales with the session's tool-output cap LEVEL via `capFor`:
 * `MCP_OUTPUT_HARD_CAP` (≈200k) base, up to `UNRESTRICTED_MCP_HARD_CAP` (≈1 MB)
 * at `max` and ≈4 MB at `ultra`.
 * Useful for sessions doing Unity work or large file reads where truncation
 * actively degrades the agent's quality.
 */
function applyOutputCap(text: string, ctx?: ToolContext): string {
  const cap = capFor(ctx?.toolOutputCapLevel ?? 'economic', MCP_OUTPUT_HARD_CAP, UNRESTRICTED_MCP_HARD_CAP);
  if (text.length <= cap) return text;
  return (
    text.slice(0, cap) +
    `\n\n${truncationMarker(`output capped at ${cap} chars`, 'refine your query, use max_tokens/limit, or paginate via offset')}`
  );
}

/** Apply applyOutputCap to a ToolResult, preserving isError. */
function capResult(r: ToolResult, ctx?: ToolContext): ToolResult {
  return { ...r, content: applyOutputCap(r.content, ctx) };
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
