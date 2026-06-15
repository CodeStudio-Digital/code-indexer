/**
 * The `api_*` agent tool set — auto-test + auto-fix of an OpenAPI surface.
 * Static array (each tool reads ctx.projectId + the module-global store), so
 * it's registered once like httpTools and gated to the `api` tool tier.
 */
import type { CoderTool } from '@mcp/code-agent/core/tool.js';
import { apiListRequestsTool, apiGetRequestTool } from './query.js';
import { apiImportOpenApiTool, apiUpdateRequestTool, apiMarkVerifiedTool } from './mutate.js';
import { apiRunRequestTool, apiRunCollectionTool } from './run.js';

export { setApiClientStore, getApiClientStore } from './store-binding.js';

export const apiClientTools: CoderTool[] = [
  apiImportOpenApiTool,
  apiListRequestsTool,
  apiGetRequestTool,
  apiRunRequestTool,
  apiUpdateRequestTool,
  apiMarkVerifiedTool,
  apiRunCollectionTool,
];
