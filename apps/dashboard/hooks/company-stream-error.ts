/** Both RPC failures and durable SSE terminals reach the Company composer. */
export function companyStreamError(payload: unknown, fallback = 'Falha na sessão. Tente novamente.'): string {
  const message = (value: unknown, depth = 0): string | null => {
    if (typeof value === 'string') return value.trim() || null;
    if (!value || typeof value !== 'object' || depth > 3) return null;
    const fields = value as Record<string, unknown>;
    for (const key of ['httpBody', 'error', 'message', 'detail', 'reason', 'code']) {
      const found = message(fields[key], depth + 1);
      if (found) return found;
    }
    return null;
  };
  return message(payload) ?? fallback;
}
