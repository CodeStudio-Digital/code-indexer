/**
 * Release check CLI: wires the pure auditor to the real native catalog and
 * exits non-zero on any finding (Fase 2 — 2A, gate 8/9). The auditor itself
 * lives in `@mcp/code-agent/core/capability-catalog` so it is unit-tested
 * from inside the package.
 */
import {
  auditCapabilityDescriptors,
} from '@mcp/code-agent/core/capability-catalog.js';
import type { CoderTool } from '@mcp/code-agent/core/tool.js';

async function loadNativeCatalog(): Promise<CoderTool[]> {
  const modules = await Promise.all([
    import('@mcp/code-agent/tools/fs.js'),
    import('@mcp/code-agent/tools/shell.js'),
    import('@mcp/code-agent/tools/git.js'),
    import('@mcp/code-agent/tools/glob.js'),
    import('@mcp/code-agent/tools/lsp.js'),
    import('@mcp/code-agent/tools/diagnostics.js'),
    import('@mcp/code-agent/tools/web.js'),
    import('@mcp/code-agent/tools/http.js'),
    import('@mcp/code-agent/tools/plan.js'),
    import('@mcp/code-agent/tools/interaction.js'),
  ]);
  const out: CoderTool[] = [];
  for (const mod of modules) {
    for (const value of Object.values(mod)) {
      if (Array.isArray(value) && value.every((v) => v && typeof v === 'object' && 'name' in v && 'handler' in v)) {
        out.push(...(value as CoderTool[]));
      }
    }
  }
  return out;
}

async function main(): Promise<void> {
  const tools = await loadNativeCatalog();
  const result = auditCapabilityDescriptors(tools);
  if (result.ok) {
    console.log(`[check-capability-descriptors] OK — ${result.checked} tools described, 0 findings`);
    return;
  }
  console.error(`[check-capability-descriptors] FAIL — ${result.findings.length} finding(s) over ${result.checked} tools:`);
  for (const finding of result.findings) {
    console.error(`  - ${finding.tool} [${finding.kind}]: ${finding.detail}`);
  }
  process.exitCode = 1;
}

void main();
