/**
 * A registry assembled like runCoder's from the real tool builders, without
 * a database or a model: native tools, index tools from the native builder
 * (names and access of the internal contract; their texts are placeholders),
 * the run's chat tools, spawn_agent and its companions (registered with the
 * switch off, catalog stand-ins with it on), workflow under Ultra and
 * invoke_skill. `directNames` runs the real buildTools for a scenario. The
 * runCoder wiring itself is covered by run-coder-catalog-swap (Electron).
 */
import { ToolRegistry } from '../../core/registry.js';
import type { ToolContext } from '../../core/tool.js';
import type { ChatProvider } from '../../providers/adapter.js';
import { buildTools } from '../../core/runner/assembly/tools.js';
import { isReadOnlyAgent } from '../../agents/index.js';
import { CHILD_CHAT_TOOL_NAMES, chatToolsForRun, withTalkDeferred } from '../chat-tool-set.js';
import { REPLACED_BY_CHILD_CHATS } from '../child-chat-surface.js';
import { withChildChatTexts } from '../child-chat-texts.js';
import { contextualTiersForRuntime, profileToTiers } from '../tiers.js';
import { fsTools } from '../fs.js';
import { shellTools } from '../shell.js';
import { gitToolsForProject } from '../git.js';
import { applyPatchTool } from '../apply-patch.js';
import { tasksTools } from '../tasks.js';
import { planTools } from '../plan.js';
import { interactionTools } from '../interaction.js';
import { toolOutputTools } from '../tool-output.js';
import { execCommandTools } from '../exec-command.js';
import { globTools } from '../glob.js';
import { ragSearchDocsTools } from '../rag-search-docs.js';
import { ragReadDocTools } from '../rag-read-doc.js';
import { previewTools } from '../preview/index.js';
import { webTools } from '../web.js';
import { buildSessionDriveTools } from '../session-drive-tools.js';
import { buildConversationChapterTools } from '../conversation-chapters.js';
import { buildProjectMemoryTools } from '../project-memory-tools.js';
import { buildCodeExecTool } from '../code-exec.js';
import { buildFindToolsTool } from '../find-tools.js';
import { buildNativeIndexTools } from '../native-index-tools.js';
import { INTERNAL_MCP_ACCESS } from '../internal-mcp-contract.js';
import { buildSpawnAgentTool } from '../spawn-agent.js';
import { buildResumeAgentTool } from '../resume-agent.js';
import { buildCollectAgentsTool } from '../collect-agents.js';
import { buildReadAgentTranscriptTool } from '../read-agent-transcript.js';
import { buildResumeChatTool } from '../chat-resume.js';
import { buildWorkflowTool } from '../workflow/workflow-tool.js';
import { buildInvokeSkillTool } from '../../skills/skill-tool-builder.js';

export interface CatalogScenario {
  childChats: boolean;
  agentId: 'build' | 'plan' | 'explore';
  ultra?: boolean;
  agenticChat?: boolean;
  preview?: boolean;
  company?: boolean;
  subagentsDisabled?: boolean;
}

const deps = { provider: {} as ChatProvider, parentTools: [] } as never;
const INDEX_PORT = {
  catalog: () => Object.keys(INTERNAL_MCP_ACCESS).filter((name) => name !== 'index_project' && name !== 'export_docs').map((name) => ({
    name, description: `${name} (index tool)`, inputSchema: { type: 'object', properties: { project_name: { type: 'string' } }, required: ['project_name'] } })),
  invoke: async () => ({ content: [] }),
} as never;

/** What runCoder registers for the scenario (same order of decisions, see index.ts). */
export function scenarioRegistry(run: CatalogScenario): ToolRegistry {
  const registry = new ToolRegistry();
  const childChats = run.childChats && !run.company;
  const cannotDelegate = !!run.subagentsDisabled || isReadOnlyAgent(run.agentId);
  registry.registerAll(chatToolsForRun({ childChats, company: !!run.company, cannotDelegate }));
  if (childChats) {
    registry.setReplacedTools(REPLACED_BY_CHILD_CHATS);
    registry.addCatalogStandIns(chatToolsForRun({ childChats: false, company: false }), CHILD_CHAT_TOOL_NAMES);
  }
  registry.registerAll([...fsTools, ...shellTools, ...gitToolsForProject(), applyPatchTool, ...tasksTools, ...planTools,
    ...interactionTools, ...toolOutputTools, ...execCommandTools, ...webTools, ...globTools, ...ragSearchDocsTools, ...ragReadDocTools,
    ...previewTools, ...buildSessionDriveTools(), ...buildConversationChapterTools(), ...buildProjectMemoryTools()]);
  registry.registerAll(buildNativeIndexTools({ port: INDEX_PORT, db: {} as never, binding: { projectName: 'p', projectRoot: '/p' } }));
  registry.register(buildCodeExecTool(registry, new Map()));
  registry.register(buildFindToolsTool(registry, new Map()));
  if (!run.company && !run.subagentsDisabled) {
    const spawn = [buildSpawnAgentTool(deps, registry), buildResumeAgentTool(deps), buildResumeChatTool(deps),
      buildCollectAgentsTool(deps), buildReadAgentTranscriptTool(undefined as never)];
    if (childChats) registry.addCatalogStandIns(spawn);
    else registry.registerAll(spawn);
    if (run.ultra) registry.register(buildWorkflowTool(deps));
  }
  registry.register(buildInvokeSkillTool([{ id: 'demo', name: 'demo', description: 'demo' } as never], {} as never, 's' as never));
  if (childChats) registry.reviseInPlace(withChildChatTexts);
  if (childChats && cannotDelegate && !run.agenticChat) registry.reviseInPlace(withTalkDeferred);
  return registry;
}

/** The direct catalog names (sorted, as published) and their serialized size. */
export function directCatalog(run: CatalogScenario, cap?: number): { names: string[]; chars: number } {
  const activeTiers = profileToTiers('full');
  for (const tier of contextualTiersForRuntime({ company: run.company, previewAvailable: run.preview, agentId: run.agentId })) activeTiers.add(tier);
  const toolContext = { cwd: '/p', projectName: 'p', agenticChat: run.agenticChat,
    runner: { agentId: run.agentId, planMode: run.agentId === 'plan' },
    ...(run.company ? { companyContext: { isMaster: false } } : {}) } as unknown as ToolContext;
  const built = buildTools({ registry: scenarioRegistry(run), activeTiers, toolContext, sessionToolCap: cap,
    provider: { name: 'fixture', model: 'claude-sonnet-4-5' } as ChatProvider });
  return { names: built.tools.map((tool) => tool.name), chars: JSON.stringify(built.tools).length };
}

