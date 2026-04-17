// Shim — the hook lives in ./agent-stream/. Kept here so existing imports
// `from './useAgentStream.js'` continue to work without churn.
export { useAgentStream } from './agent-stream/index.js';
export type {
  AgentAttachment,
  AgentsGroup,
  AgentStatus,
  AssistantTurn,
  ContextStatus,
  IndexStatus,
  ParallelAgent,
  PlanPrompt,
  QuestionPrompt,
  RunDelta,
  SessionState,
  StreamBlock,
  StreamTask,
  StreamTaskExecutionMode,
  StreamTaskMode,
  StreamTaskStatus,
  TasksPrompt,
  ToolCallEvent,
  Usage,
} from './agent-stream/index.js';
