
export const COMPACTION_SUMMARY_V3_VERSION = 3 as const;

export const COMPACTION_SUMMARY_TIMEOUT_MS = 45_000;

export const COMPACTION_SUMMARY_MAX_CHARS = 8_000;

export const COMPACTION_SUMMARY_MAX_TOKENS = 1_500;

export function clipMiddle(value: string, cap: number): string {
  if (value.length <= cap) return value;
  if (cap <= 1) return value.slice(-Math.max(0, cap));
  if (cap < 16) return value.slice(-cap);
  const suffix = Math.max(6, Math.floor(cap * 0.45));
  const prefix = cap - suffix - 1;
  return `${value.slice(0, prefix)}…${value.slice(-suffix)}`;
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
