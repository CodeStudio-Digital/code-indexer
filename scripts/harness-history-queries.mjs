import assert from 'node:assert/strict';

/** Compare bounded HTTP reads with an independently fetched stable transcript. */
export async function assertHistoryQueries(dashboard, sessionId, full) {
  const maximum = full.message_rows.at(-1)?.seq ?? 0;
  const responses = await dashboard.evaluate(async ({ id, maximum }) => {
    const values = [];
    for (const path of [`${id}?tail=1`, `${id}/messages?before_seq=${maximum + 1}&limit=1`]) {
      const response = await fetch(`mcp://app/api/coder/sessions/${path}`, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`bounded history ${response.status}: ${await response.text()}`);
      values.push(await response.json());
    }
    return values;
  }, { id: sessionId, maximum });
  const first = full.message_rows.findLastIndex(row => row.role !== 'tool');
  const expected = full.message_rows.slice(Math.max(0, first));
  assert.deepEqual(responses[0].message_rows, expected.slice(0, 5), 'tail window differs from committed transcript');
  assert.deepEqual(responses[0].messages, full.messages.slice(Math.max(0, first), Math.max(0, first) + 5));
  assert.equal(responses[0].total_messages, full.total_messages, 'bounded count lost messages');
  assert.deepEqual(responses[1].message_rows, expected, 'page differs from committed transcript');
  assert.equal(responses[1].next_before_seq, first > 0 ? expected[0].seq : null);
  const preceding = full.message_rows.slice(0, Math.max(0, first)).findLast(row => row.role === 'user' && row.is_meta === 0)?.seq ?? null;
  assert.equal(responses[0].preceding_user_seq, preceding);
  assert.equal(responses[1].preceding_user_seq, preceding);
  return { totalMessages: full.total_messages, tailRows: responses[0].message_rows.length,
    pageRows: responses[1].message_rows.length, precedingUserSeq: preceding };
}
