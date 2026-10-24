
export interface SubagentCollected {
  memos: ReadonlyArray<import('@mcp/code-agent/tools/subagent-collector.js').SubagentMemo>;
  snapshots: ReadonlyArray<import('@mcp/code-agent/tools/subagent-collector.js').SubagentSnapshotRef>;
  boardPosts: ReadonlyArray<import('@mcp/code-agent/tools/subagent-collector.js').SubagentBoardPostRef>;
}
