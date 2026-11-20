/**
 * Workflow floors of the stable catalog projection (tools/workflow-catalog.ts):
 * the complete surface of a narrow specialist role, and the minimal preview
 * loop. The old priority ranking for a capped catalog was removed with the
 * non-stable projection.
 */
import {
  API_TOOLS,
  BROWSER_TOOLS,
  DB_TOOLS,
  DIAGRAM_TOOLS,
  QA_TOOLS,
} from '@mcp/code-agent/tools/tiers.js';

/**
 * Complete defining surfaces for narrow specialist/product roles. Tier
 * filtering runs before this floor, so unowned capabilities add zero tools;
 * once a matching runtime activates one, the model cap cannot erase half of
 * that role's identity. Broad Company/sandbox tiers keep their smaller
 * essential floor, while preview keeps its closed-loop subset below.
 */
export const ROLE_CAPABILITY_FLOOR: ReadonlySet<string> = new Set([
  ...API_TOOLS,
  ...BROWSER_TOOLS,
  ...DB_TOOLS,
  ...DIAGRAM_TOOLS,
  ...QA_TOOLS,
]);

/**
 * Minimal closed-loop browser workflow. The preview tier is auto-active only
 * for an explicitly preview-capable launch or a Company role whose identity is
 * visual/QA (their worker path does not carry previewAvailable). Protecting
 * this floor therefore does not tax unrelated sessions. Keeping all 22 tools
 * would crowd out coding tools on compact models; the rest stay discoverable.
 */
export const PREVIEW_WORKFLOW_FLOOR: ReadonlySet<string> = new Set([
  'preview_open',
  'preview_snapshot',
  'preview_click',
  'preview_fill',
  'preview_screenshot',
  'preview_console',
]);
