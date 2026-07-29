function suffix(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0 || value > 999_999_999_999) {
    throw new TypeError(`UUID fixture suffix out of range: ${value}`);
  }
  return String(value).padStart(12, '0');
}

export function agentRunId(value: number): string {
  return `a0000000-0000-4000-8000-${suffix(value)}`;
}

export function companySessionId(value: number): string {
  return `c0000000-0000-4000-8000-${suffix(value)}`;
}
