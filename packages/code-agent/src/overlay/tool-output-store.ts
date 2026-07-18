import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/**
 * Side-file store for large tool outputs.
 *
 * When `buildToolResultBlock` would truncate a tool output (content.length >
 * PUSH_TIME_CAP), the runner persists the FULL content to this store under a
 * deterministic content-hash ID and embeds the ID in the truncation marker.
 * The agent can then retrieve the full content on demand via the
 * `get_tool_output(id)` native tool.
 *
 * Why content-hash IDs and not timestamps? Determinism: two identical tool
 * outputs produce the same ID, so the prefix cache stays byte-stable across
 * retries and resumes. No timestamps leak into the history.
 *
 * The store is scoped per session: files live at
 *   {cwd}/.mcp-indexer/coder/tool-outputs/{sessionId}/{id}.txt
 *
 * GC: files older than TOOL_OUTPUT_TTL_DAYS (default 7) are pruned on init.
 */

const TTL_DAYS = Number(process.env.CODER_TOOL_OUTPUT_TTL_DAYS ?? 7);
const TTL_MS = TTL_DAYS * 24 * 60 * 60 * 1000;

export class ToolOutputStore {
  private readonly dir: string;

  constructor(
    projectRoot: string,
    sessionId: number | string,
    opts: { externalBaseDir?: string } = {},
  ) {
    this.dir = opts.externalBaseDir
      ? join(opts.externalBaseDir, String(sessionId))
      : join(projectRoot, '.mcp-indexer', 'coder', 'tool-outputs', String(sessionId));
    try {
      mkdirSync(this.dir, { recursive: true });
    } catch {
      // Dir creation may fail in read-only test envs; callers check put() result.
    }
    this.gc();
  }

  /**
   * Persist `content` and return a short deterministic ID (first 12 chars of
   * the sha256 hex digest). Safe to call repeatedly with the same content —
   * subsequent calls are no-ops (idempotent write).
   */
  put(content: string): string | null {
    try {
      const id = createHash('sha256').update(content).digest('hex').slice(0, 12);
      const path = join(this.dir, `${id}.txt`);
      if (!existsSync(path)) writeFileSync(path, content, 'utf-8');
      return id;
    } catch (e) {
      console.warn(`[tool-output-store] put failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /** Return the full content for an ID, or null if the file is missing. */
  get(id: string): string | null {
    // Guard against path-traversal in the ID — only accept hex digits.
    if (!/^[a-f0-9]{6,64}$/.test(id)) return null;
    try {
      return readFileSync(join(this.dir, `${id}.txt`), 'utf-8');
    } catch {
      return null;
    }
  }

  /**
   * Whether this session currently has at least one recoverable snapshot.
   *
   * The runner uses this to keep `get_tool_output` out of the provider-facing
   * catalog until there is a real ID the model can copy. Besides saving one
   * tool definition, this prevents speculative placeholder calls such as
   * `output_id: "nonexistent"` in sessions that never spilled an output.
   */
  hasOutputs(): boolean {
    try {
      return existsSync(this.dir) && readdirSync(this.dir).some((entry) => entry.endsWith('.txt'));
    } catch {
      return false;
    }
  }

  /** Prune files older than TTL_MS. Best-effort, failures are swallowed. */
  private gc(): void {
    try {
      if (!existsSync(this.dir)) return;
      const now = Date.now();
      for (const entry of readdirSync(this.dir)) {
        if (!entry.endsWith('.txt')) continue;
        const full = join(this.dir, entry);
        try {
          const s = statSync(full);
          if (now - s.mtimeMs > TTL_MS) unlinkSync(full);
        } catch {
          /* ignore single-file errors */
        }
      }
    } catch {
      /* ignore */
    }
  }
}
