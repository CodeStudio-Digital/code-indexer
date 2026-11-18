/**
 * Public entry point for QA-related company tools. Currently a single
 * tool; phase 2 will add `qa_coverage_audit`, `wait_for_file_change`,
 * and friends here.
 */
import type { CoderTool } from '@mcp/code-agent/core/tool.js';
import type { CompanyOrchestratorPort as CompanyOrchestrator } from '@mcp/company/orchestrator-port.js';
import { qaPublishResult } from '@mcp/company/tools/qa/qa-publish-result.js';
import { qaStartRun } from '@mcp/company/tools/qa/qa-start-run.js';
import { qaGetBrowserEndpoint } from '@mcp/company/tools/qa/qa-get-browser-endpoint.js';
import { qaCheckPreview } from './qa-check-preview.js';

export { qaPublishResult } from '@mcp/company/tools/qa/qa-publish-result.js';
export { qaStartRun, setQaTestRunStore } from '@mcp/company/tools/qa/qa-start-run.js';
export {
  qaGetBrowserEndpoint,
  collectPlaywrightBaseUrls,
  setQaEndpointEnvStore,
  getQaEndpointEnvStore,
} from '@mcp/company/tools/qa/qa-get-browser-endpoint.js';
export { preflightBrowser } from '@mcp/company/tools/qa/qa-preflight.js';
export { resolvePlanGate, roleHasQaPlaywrightSkill } from '@mcp/company/tools/qa/qa-plan-gate.js';
export type * from '@mcp/company/tools/qa/qa-event-types.js';

/**
 * Build the QA tool set for a subordinate runner. Always registered for
 * any subordinate in a company session — actual gating is via the skill's
 * `allowed-tools` list (the skill `qa-playwright` includes the QA tools;
 * subordinates without that skill see the tools but the prompt won't
 * instruct them to use them).
 */
export function buildQaTools(
  orchestrator: CompanyOrchestrator,
  agentRole: string,
  agentRunId: string | null,
): CoderTool[] {
  return [
    qaStartRun(orchestrator, agentRole, agentRunId),
    qaCheckPreview(orchestrator, agentRole, agentRunId),
    qaPublishResult(orchestrator, agentRole, agentRunId),
    qaGetBrowserEndpoint(orchestrator, agentRole, agentRunId),
  ];
}
