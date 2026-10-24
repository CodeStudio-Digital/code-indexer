// Shim — the hook lives in ./agent-stream/. Kept here so existing imports
// `from './useAgentStream.js'` continue to work without churn.
export { useAgentCurrentTurn, useAgentStream } from './agent-stream/index.js';
export type { AgentAttachment, AgentsGroup, AssistantTurn, ContextStatus, DecisionAnswers, DecisionQuestion, IndexStatus, ParallelAgent, PlanResolution, RunDelta, SessionId, StreamBlock, StreamTask, StreamTaskExecutionMode, TaskRunState, TaskRunTask, TasksPrompt, ToolCallEvent, Usage, WorkflowRunState, WorkflowStepView } from './agent-stream/index.js';
