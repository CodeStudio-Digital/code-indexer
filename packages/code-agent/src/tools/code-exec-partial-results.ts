interface ReadOutcome {
  name: string;
  args: Record<string, unknown>;
  content: string;
  status: string;
  delivered: boolean;
  readOnly?: boolean;
}

/** Keep small completed reads visible when a sibling fails, without replay. */
export function completedReadResults(outcomes: readonly ReadOutcome[]): string {
  const results: string[] = [];
  let remaining = 8000;
  for (const outcome of outcomes) {
    if (!outcome.readOnly || !outcome.delivered || outcome.status !== 'succeeded') continue;
    // Include complete small results only. Larger results remain in the full
    // batch record; a partial file could otherwise be mistaken for all of it.
    if (!outcome.content || outcome.content.length > 2400) continue;
    const path = typeof outcome.args.path === 'string' ? outcome.args.path : undefined;
    const label = JSON.stringify({ tool: outcome.name, ...(path ? { path } : {}) });
    const result = `${label}\n${outcome.content}`;
    if (result.length > remaining || results.length >= 3) break;
    remaining -= result.length;
    results.push(result);
  }
  return results.length ? `\n\n[Completed read results; reuse these without repeating the calls]\n${results.join('\n\n')}` : '';
}
