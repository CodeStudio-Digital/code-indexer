import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { err } from '@mcp/code-agent/core/tool.js';
import { webFetch, webSearch } from '@mcp/code-agent/tools/web.js';
import { APP_ARCHITECTURE_SOURCE_DOMAINS } from '@mcp/app-studio/architecture/types.js';

const SEARCH_PARAMETERS: JsonSchema = {
  type: 'object',
  properties: { query: { type: 'string', description: 'Short technical documentation query.' } },
  required: ['query'],
};
const FETCH_PARAMETERS: JsonSchema = {
  type: 'object',
  properties: { url: { type: 'string', description: 'Official documentation URL returned by app_search_architecture_docs.' } },
  required: ['url'],
};

export const appSearchArchitectureDocs: CoderTool = {
  name: 'app_search_architecture_docs',
  description: 'Search only approved official documentation domains for current App Studio architecture decisions.',
  parameters: SEARCH_PARAMETERS,
  source: 'native',
  handler: (args, ctx) => webSearch.handler({ query: args.query, allowed_domains: [...APP_ARCHITECTURE_SOURCE_DOMAINS] }, ctx),
};

export const appFetchArchitectureDoc: CoderTool = {
  name: 'app_fetch_architecture_doc',
  description: 'Fetch one official architecture documentation page. Non-official domains are rejected.',
  parameters: FETCH_PARAMETERS,
  source: 'native',
  handler: (args, ctx) => {
    try {
      const url = new URL(String(args.url ?? ''));
      if (!APP_ARCHITECTURE_SOURCE_DOMAINS.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) {
        return Promise.resolve(err(`Domain '${url.hostname}' is not approved for App Studio architecture research.`));
      }
      return webFetch.handler({ url: url.toString() }, ctx);
    } catch {
      return Promise.resolve(err('url must be a valid official documentation URL.'));
    }
  },
};
