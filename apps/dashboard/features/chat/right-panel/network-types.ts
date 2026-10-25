import type { ChatNetworkConfig, ChatTrigger } from '@mcp/session-storage/collaboration/network-types.js';
export interface NetworkPeer { id: string; sessionId: string; label: string; profile: string; state: string; parentId?: string }
export interface NetworkMessage { id: string; from: string; to: string; kind: string; body: string; status: string; replyTo?: string; references: string[] }
export interface NetworkData {
  self: string; peers: NetworkPeer[]; messages: NetworkMessage[];
  candidates: Array<{ id: string; title: string }>;
  config: ChatNetworkConfig;
  links: Array<{ sessions: string[]; enabled: boolean }>;
  triggers: ChatTrigger[]; wakeCount: number; rootBudget: number;
  chats: Array<{ id: string; title: string; projectId: number | null; provider: string; model: string }>;
  projects?: Array<{ id: number; name: string }>;
  policy?: { effective: { reasoning: { effort?: string }; parallelism: { maxAgents: number }; orchestration: string } };
}
