/**
 * Description style contract — terse-safety.
 *
 * Two terse transforms shorten tool descriptions to their first sentence:
 *  - `terseDescription` (code-agent descriptions.ts) — applied by the runner
 *    assembly to EVERY tool on bootstrap-only profiles and compact models.
 *  - the MCP bridge's transform (mcp-bridge.ts) — applied to server-provided
 *    descriptions when CODER_TERSE_TOOLS=1.
 * Both cut at the first '.' or '\n' within 150 chars, else hard-cut at 150.
 *
 * Contract enforced here (audit 2026-07-01, docs/audit/TOOL_AUDIT.md): every
 * description longer than 150 chars must have a first sentence that
 *  (a) terminates within 150 chars (no mid-word hard-cut),
 *  (b) does not end at an abbreviation dot (e.g. / i.e. / etc.),
 *  (c) is ≥25 chars — long enough to identify the tool when it is ALL the
 *      model sees.
 * Factory-built company tools (master/subordinate closures) are covered by
 * their exported *_DESC constants' modules being terse-safe at authoring time;
 * they cannot be instantiated here without a live orchestrator.
 */
import { describe, expect, it } from 'vitest';
import { terseDescription } from '@mcp/code-agent/tools/descriptions.js';

// ── Static tool arrays (code-agent) — same set as tier-contract.test.ts ────
import { fsTools } from '@mcp/code-agent/tools/fs.js';
import { applyPatchTool } from '@mcp/code-agent/tools/apply-patch.js';
import { shellTools } from '@mcp/code-agent/tools/shell.js';
import { gitTools } from '@mcp/code-agent/tools/git.js';
import { planTools } from '@mcp/code-agent/tools/plan.js';
import { specTools } from '@mcp/code-agent/tools/spec/index.js';
import { tasksTools } from '@mcp/code-agent/tools/tasks.js';
import { interactionTools } from '@mcp/code-agent/tools/interaction.js';
import { toolOutputTools } from '@mcp/code-agent/tools/tool-output.js';
import { diagnosticsTools } from '@mcp/code-agent/tools/diagnostics.js';
import { lspTools } from '@mcp/code-agent/tools/lsp.js';
import { execCommandTools } from '@mcp/code-agent/tools/exec-command.js';
import { webTools } from '@mcp/code-agent/tools/web.js';
import { httpTools } from '@mcp/code-agent/tools/http.js';
import { globTools } from '@mcp/code-agent/tools/glob.js';
import { ragSearchDocsTools } from '@mcp/code-agent/tools/rag-search-docs.js';
import { ragReadDocTools } from '@mcp/code-agent/tools/rag-read-doc.js';
import { viewImageTools } from '@mcp/code-agent/tools/view-image.js';
import { previewTools } from '@mcp/code-agent/tools/preview/index.js';
import { listAgentsTools } from '@mcp/code-agent/tools/list-agents.js';
import { waitAgentsTools } from '@mcp/code-agent/tools/wait-agents.js';
import { sendMessageTools } from '@mcp/code-agent/tools/send-message.js';
import { sendInputTools } from '@mcp/code-agent/tools/send-input.js';
import { followupTaskTools } from '@mcp/code-agent/tools/followup-task.js';
import { worktreeTools } from '@mcp/code-agent/tools/worktree.js';
import { apiClientTools } from '@mcp/code-agent/tools/api-client/index.js';

// ── Static tool arrays (@mcp/company — builder mode) ───────────────────────
import { sandboxTools } from '@mcp/company/tools/sandbox-tools.js';
import { docsTools as companyDocsTools } from '@mcp/company/tools/docs-tools.js';
import { envTools } from '@mcp/company/tools/env-tools.js';

// ── MCP server surface (descriptions flow to the LLM through the bridge) ───
import { allTools as mcpServerTools } from '@apps/mcp-server/tools/index.js';

type NamedTool = { name: string; description?: string };
const arr = (x: NamedTool | readonly NamedTool[]): NamedTool[] =>
  Array.isArray(x) ? [...x] : [x as NamedTool];

const CODE_AGENT_TOOLS: NamedTool[] = [
  ...fsTools, applyPatchTool, ...shellTools, ...gitTools, ...planTools, ...specTools,
  ...tasksTools, ...interactionTools, ...toolOutputTools, ...diagnosticsTools, ...lspTools,
  ...execCommandTools, ...webTools, ...httpTools, ...globTools, ...ragSearchDocsTools,
  ...ragReadDocTools, ...viewImageTools, ...previewTools,
  ...listAgentsTools, ...waitAgentsTools, ...sendMessageTools, ...sendInputTools,
  ...followupTaskTools, ...worktreeTools, ...apiClientTools,
  ...sandboxTools, ...companyDocsTools, ...envTools,
].flatMap(arr);

/** Replica of the MCP bridge transform (mcp-bridge.ts) — keep in sync. */
function bridgeTerse(desc: string): string {
  if (desc.length <= 150) return desc;
  const firstStop = desc.search(/[.\n]/);
  if (firstStop > 0 && firstStop <= 150) return desc.slice(0, firstStop + 1).trim();
  return desc.slice(0, 150).trim() + '…';
}

const ABBREV_TAIL = /\b(e\.g|i\.e|vs|etc|approx|incl)\.$/i;
const MIN_TERSE_LEN = 25;

function violations(tools: NamedTool[], transform: (d: string) => string): string[] {
  const out: string[] = [];
  for (const t of tools) {
    const desc = t.description ?? '';
    const terse = transform(desc);
    if (terse === desc) continue; // ≤150 chars — never trimmed
    if (terse.endsWith('…')) {
      out.push(`${t.name}: hard-cut — first '.' or '\\n' must appear within 150 chars ("${terse.slice(0, 60)}…")`);
    } else if (ABBREV_TAIL.test(terse)) {
      out.push(`${t.name}: first sentence ends at an abbreviation dot ("…${terse.slice(-25)}")`);
    } else if (terse.length < MIN_TERSE_LEN) {
      out.push(`${t.name}: terse form too short to identify the tool ("${terse}")`);
    }
  }
  return out;
}

describe('description style — terse-safety contract', () => {
  it('sanity: surfaces actually imported (guards against silent import breakage)', () => {
    expect(CODE_AGENT_TOOLS.length).toBeGreaterThanOrEqual(80);
    // 27 after the 2026-07 audit retirements (33 − 6).
    expect(mcpServerTools.length).toBeGreaterThanOrEqual(25);
  });

  it('code-agent + company static tools survive the runner terse transform', () => {
    const bad = violations(CODE_AGENT_TOOLS, terseDescription);
    expect(bad, `terse-unsafe descriptions (fix the first sentence):\n${bad.join('\n')}`).toEqual([]);
  });

  it('MCP server tools survive the bridge terse transform', () => {
    const bad = violations(mcpServerTools as NamedTool[], bridgeTerse);
    expect(bad, `terse-unsafe descriptions (fix the first sentence):\n${bad.join('\n')}`).toEqual([]);
  });

  it('the two transforms agree on where the first sentence ends', () => {
    for (const t of CODE_AGENT_TOOLS) {
      const desc = t.description ?? '';
      if (desc.length <= 150) continue;
      expect(terseDescription(desc), t.name).toBe(bridgeTerse(desc));
    }
  });
});
