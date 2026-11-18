import { getQaEndpointEnvStore } from './qa-endpoint-state.js';
export { setQaEndpointEnvStore, getQaEndpointEnvStore } from './qa-endpoint-state.js';
import type { CoderTool } from "@mcp/code-agent/core/tool.js";
import type { JsonSchema } from "@mcp/provider-sdk";
import { ok, err } from "@mcp/agent-runtime-host/tool-result.js";
import type { CompanyOrchestratorPort as CompanyOrchestrator } from '@mcp/company/orchestrator-port.js';
import type { CompanySessionEnvStore } from '@mcp/store/company-session-env-store.js';
import { preflightBrowser } from './qa-preflight.js';

const PARAMETERS: JsonSchema = { type: 'object', properties: {} };

export async function collectPlaywrightBaseUrls(
  store: CompanySessionEnvStore | null,
  sessionId: string | null,
): Promise<Array<{ key: string; value: string }>> {
  if (!store || sessionId == null) return [];
  try {
    return (await store.listAsync(sessionId))
      .filter((row) => row.key === 'PLAYWRIGHT_BASE_URL' || row.key.startsWith('PLAYWRIGHT_BASE_URL_'))
      .map((row) => ({ key: row.key, value: row.value }))
      .sort((a, b) => a.key.localeCompare(b.key));
  } catch {
    return [];
  }
}

export function formatEndpointReply(
  wsEndpoint: string,
  previewUrls: Array<{ key: string; value: string }> = [],
): string {
  const lines = [
    `wsEndpoint: ${wsEndpoint}`,
  ];
  if (previewUrls.length > 0) {
    lines.push('');
    lines.push('Preview URLs (use these as Playwright `baseURL`):');
    for (const { key, value } of previewUrls) {
      lines.push(`  ${key}: ${value}`);
    }
  }
  lines.push('');
  lines.push('Playwright Test reads this endpoint from PLAYWRIGHT_WS_ENDPOINT.');
  return lines.join('\n');
}

export function qaGetBrowserEndpoint(
  orchestrator: CompanyOrchestrator,
  agentRole: string,
  agentRunId: string | null,
): CoderTool {
  void agentRole;
  void agentRunId;
  return {
    name: 'qa_get_browser_endpoint',
    description:
      'Return the explicitly configured Playwright WebSocket endpoint and preview URLs for a QA suite.',
    parameters: PARAMETERS,
    source: 'native',
    handler: async () => {
      try {
        const sessionId = orchestrator.companySessionId;
        const previewUrls = await collectPlaywrightBaseUrls(getQaEndpointEnvStore(), sessionId);
        const preflight = await preflightBrowser({ sessionId });
        if (preflight.ok) return ok(formatEndpointReply(preflight.wsEndpoint, previewUrls));
        return ok(preflight.message);
      } catch (e) {
        return err(`qa_get_browser_endpoint failed: ${(e as Error).message}`);
      }
    },
  };
}
