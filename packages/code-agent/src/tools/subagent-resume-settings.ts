import type { ResumeRegistryConfiguration } from './subagent-resume-types.js';
const DEFAULT_CONFIGURATION: Readonly<ResumeRegistryConfiguration> = Object.freeze({
  maxAgentBytes: 4 * 1024 * 1024,
  maxSessionBytes: 48 * 1024 * 1024,
  ttlMs: 45 * 60_000,
  leaseMs: 120_000,
  spillTerminalTranscripts: true,
  retainCompletedTranscripts: true,
  sweepIntervalMs: 5 * 60_000,
});

export let configuration: Readonly<ResumeRegistryConfiguration> = DEFAULT_CONFIGURATION;

// Caps read lazily so ops can tune them via env before the first spawn (a
// module-const would freeze the value at import).
export function maxAgentBytes(): number {
  return configuration.maxAgentBytes;
}

export function maxSessionBytes(): number {
  return configuration.maxSessionBytes;
}

export function ttlMs(): number {
  return configuration.ttlMs;
}

export function leaseMs(): number {
  return configuration.leaseMs;
}

/**
 * Spill COMPLETED transcripts to disk (default ON). `CODER_RESUME_SPILL=0`
 * keeps them in RAM (the pre-spill behavior). Only completed agents are ever
 * spilled — failed/aborted stay in RAM so resume_agent keeps working.
 */
export function spillTerminalTranscripts(): boolean {
  return configuration.spillTerminalTranscripts;
}

/** How often the unref'd worker timer reclaims idle sessions (default 5min). */
export function sweepIntervalMs(): number {
  return configuration.sweepIntervalMs;
}

/**
 * Whether transcripts of COMPLETED agents are retained too. Default ON since
 * the observability work (read_agent_transcript + the dashboard Transcript
 * tab need them); `CODER_RESUME_RETAIN_COMPLETED=0` restores failed-only.
 * Byte caps (per-agent/per-session) and TTL bound the extra memory.
 */
export function retainCompletedTranscripts(): boolean {
  return configuration.retainCompletedTranscripts;
}

export function configureResumeSettings(overrides: Partial<ResumeRegistryConfiguration> | null): void {
  configuration = overrides
    ? Object.freeze({ ...DEFAULT_CONFIGURATION, ...overrides })
    : DEFAULT_CONFIGURATION;
}
