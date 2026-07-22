import type { ResolutionReason } from './runs.js';

export interface UltraPreset {
  schemaVersion: 1;
  presetId: string;
  version: string;
  reasoning: { mode: 'auto' | 'off' | 'enabled' | 'discrete'; effort?: string };
  orchestration: 'off' | 'manual' | 'suggest' | 'dynamic';
  parallelism: { maxAgents: number; maxWaves?: number };
  maxDepth: number;
  verification: 'off' | 'selective' | 'required';
  backgroundPolicy: 'foreground_only' | 'allowed' | 'preferred';
  durability: 'ephemeral' | 'durable';
  isolation: 'shared_read' | 'exclusive_worktree' | 'sandbox';
  budgetRef?: string;
  modelPolicyRef?: string;
}

export interface PresetResolution {
  schemaVersion: 1;
  presetId: string;
  presetVersion: string;
  requested: UltraPreset;
  effective: UltraPreset;
  reasons: ResolutionReason[];
  resolvedAt: string;
}
