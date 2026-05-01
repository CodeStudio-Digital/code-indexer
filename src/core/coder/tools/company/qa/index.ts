/**
 * Public entry point for QA-related company tools. Currently a single
 * tool; phase 2 will add `qa_coverage_audit`, `wait_for_file_change`,
 * and friends here.
 */
import type { CoderTool } from '../../../core/tool.js';
import type { CompanyOrchestrator } from '../../../company/orchestrator.js';
import { qaPublishResult } from './qa-publish-result.js';
import { qaStartRun } from './qa-start-run.js';
import { qaGetBrowserEndpoint } from './qa-get-browser-endpoint.js';

export { qaPublishResult } from './qa-publish-result.js';
export { qaStartRun, setQaTestRunStore } from './qa-start-run.js';
export {
  qaGetBrowserEndpoint,
  fetchSidecarVersion,
  formatBrowserEndpointReply,
  collectPlaywrightBaseUrls,
  setQaEndpointEnvStore,
} from './qa-get-browser-endpoint.js';
export type * from './qa-event-types.js';

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
  agentRunId: number | null,
): CoderTool[] {
  return [
    qaStartRun(orchestrator, agentRole, agentRunId),
    qaPublishResult(orchestrator, agentRole, agentRunId),
    qaGetBrowserEndpoint(orchestrator, agentRole, agentRunId),
  ];
}
