/** Scoped, tool-constrained agent loop (no session/persistence/god-files). */
export { runMiniAgent } from './loop.js';
export type {
  MiniTool,
  MiniDelta,
  MiniConfirmFn,
  MiniConfirmCall,
  RunMiniAgentOpts,
} from './types.js';
