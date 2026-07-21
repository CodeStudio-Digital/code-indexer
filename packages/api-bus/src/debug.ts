import type { ApiContext, AsyncStream } from './common.js';

export type DebugSessionState =
  | 'starting'
  | 'initializing'
  | 'configuring'
  | 'running'
  | 'paused'
  | 'terminating'
  | 'terminated'
  | 'error';

export interface DebugAdapterInfo {
  id: string;
  label: string;
  description?: string;
  languageIds: string[];
  filePatterns?: string[];
  runnerManagers?: string[];
  supports?: Record<string, boolean | undefined>;
  namespace: string;
  executable: boolean;
}

export interface DebugRunnerInput {
  manager: string;
  script?: string;
  executable?: string;
  args?: string[];
  command?: string;
  cwd?: string;
  env?: Record<string, string>;
}

export interface DebugSourceBreakpoint {
  line: number;
  column?: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

export interface DebugBreakpoint {
  id?: number;
  verified: boolean;
  message?: string;
  source?: DebugSource;
  line?: number;
  column?: number;
}

export interface DebugSourceBreakpoints {
  path: string;
  breakpoints: DebugSourceBreakpoint[];
}

export interface DebugSource {
  name?: string;
  path?: string;
  sourceReference?: number;
}

export interface DebugStoppedState {
  reason: string;
  description?: string;
  threadId?: number;
  allThreadsStopped?: boolean;
}

export interface DebugOutputLine {
  category?: string;
  output: string;
  timestamp: number;
}

export interface DebugSessionSummary {
  sessionId: string;
  projectId: number;
  adapterId: string;
  name: string;
  state: DebugSessionState;
  startedAt: number;
  stopped?: DebugStoppedState;
  exitCode?: number;
  error?: string;
  output: DebugOutputLine[];
}

export interface DebugThread {
  id: number;
  name: string;
}

export interface DebugStackFrame {
  id: number;
  name: string;
  source?: DebugSource;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

export interface DebugScope {
  name: string;
  variablesReference: number;
  expensive: boolean;
  source?: DebugSource;
  line?: number;
  column?: number;
}

export interface DebugVariable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
  namedVariables?: number;
  indexedVariables?: number;
  evaluateName?: string;
}

export interface DebugEvaluateResult {
  result: string;
  type?: string;
  variablesReference: number;
  namedVariables?: number;
  indexedVariables?: number;
}

export interface DebugStartInput {
  projectId: number;
  adapterId: string;
  request?: 'launch' | 'attach';
  name?: string;
  file?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  runner?: DebugRunnerInput;
  configuration?: Record<string, unknown>;
  breakpoints?: DebugSourceBreakpoints[];
}

export interface DebugApi {
  adapters(input: { projectId?: number } | undefined, ctx: ApiContext): Promise<DebugAdapterInfo[]>;
  start(input: DebugStartInput, ctx: ApiContext): Promise<DebugSessionSummary>;
  list(input: void, ctx: ApiContext): Promise<DebugSessionSummary[]>;
  events(input: void, ctx: ApiContext): AsyncStream<DebugSessionSummary[]>;
  stop(input: { sessionId: string }, ctx: ApiContext): Promise<void>;
  pause(input: { sessionId: string; threadId: number }, ctx: ApiContext): Promise<void>;
  continue(input: { sessionId: string; threadId: number }, ctx: ApiContext): Promise<void>;
  next(input: { sessionId: string; threadId: number }, ctx: ApiContext): Promise<void>;
  stepIn(input: { sessionId: string; threadId: number }, ctx: ApiContext): Promise<void>;
  stepOut(input: { sessionId: string; threadId: number }, ctx: ApiContext): Promise<void>;
  setBreakpoints(
    input: { sessionId: string; source: DebugSourceBreakpoints },
    ctx: ApiContext,
  ): Promise<DebugBreakpoint[]>;
  threads(input: { sessionId: string }, ctx: ApiContext): Promise<DebugThread[]>;
  stackTrace(
    input: { sessionId: string; threadId: number; startFrame?: number; levels?: number },
    ctx: ApiContext,
  ): Promise<{ stackFrames: DebugStackFrame[]; totalFrames?: number }>;
  scopes(input: { sessionId: string; frameId: number }, ctx: ApiContext): Promise<DebugScope[]>;
  variables(
    input: { sessionId: string; variablesReference: number; start?: number; count?: number },
    ctx: ApiContext,
  ): Promise<DebugVariable[]>;
  evaluate(
    input: { sessionId: string; expression: string; frameId?: number; context?: 'watch' | 'repl' | 'hover' },
    ctx: ApiContext,
  ): Promise<DebugEvaluateResult>;
}
