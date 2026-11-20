import type { IndexerConfig } from '@mcp/shared/utils/config.js';
import { createIndexToolsPort } from '@mcp/indexer/agent-tools/port.js';
import type { CoderTool, ToolContext } from '@mcp/code-agent/core/tool.js';
import { buildNativeIndexTools } from '@mcp/code-agent/tools/native-index-tools.js';
import { prefixedBridgeTools } from '@mcp/code-agent/tools/internal-mcp-exposure.js';
import { docsTools } from '@mcp/code-agent/tools/index-docs/docs.js';
import { SessionFileKnowledge } from '@mcp/code-agent/tools/file-knowledge.js';
import type { ParityFixture } from './fixture.js';
import type { ParityFakes } from './fakes.js';

/** No loopback, config file or network: the port gets the fixture's fakes. */
const CONFIG = {} as IndexerConfig;
const SECOND_SLUG = 'parity_second';

/** The native route (in-process port): its tools, fixture and fakes. */
export interface ParityRoute {
  name: 'native';
  tools: Map<string, CoderTool>;
  fx: ParityFixture;
  fakes: ParityFakes;
}

const index = (list: CoderTool[]) => new Map(list.map(tool => [tool.name, tool]));

function binding(fx: ParityFixture, project: 'main' | 'second' | 'ghost') {
  if (project === 'second') return { projectName: fx.second.name, projectRoot: fx.secondRoot };
  return { projectName: project === 'ghost' ? 'parity-ghost' : fx.main.name, projectRoot: fx.root };
}

/** Primary tools, plus the prefixed tools of the second project, as runCoder registers them. */
export function nativeRoute(fx: ParityFixture, fakes: ParityFakes, project: 'main' | 'ghost' = 'main'): ParityRoute {
  const port = createIndexToolsPort({ config: CONFIG, extraTools: docsTools,
    semanticSearchClient: fakes.semanticSearchClient, mutationSinkWake: fakes.mutationSinkWake });
  const source = (b: ReturnType<typeof binding>) => buildNativeIndexTools({ port, db: fx.db, binding: b });
  const tools = index([
    ...source(binding(fx, project)),
    ...prefixedBridgeTools(source(binding(fx, 'second')), SECOND_SLUG),
  ]);
  return { name: 'native', tools, fx, fakes };
}

/** A fresh context per call: file knowledge and overlay keep state. */
export function toolContext(route: ParityRoute, extra: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: route.fx.root, projectId: route.fx.main.id, sessionId: 's-parity', signal: new AbortController().signal,
    toolOutputCapLevel: 'economic', fileKnowledge: new SessionFileKnowledge(),
    ...extra,
  } as unknown as ToolContext;
}
