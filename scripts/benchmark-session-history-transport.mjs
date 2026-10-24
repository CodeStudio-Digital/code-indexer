import { MessageChannel } from 'node:worker_threads';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { queryConversationProjection } from '@mcp/session-storage/fs-store/conversation-projection-query.js';

// Transport component only: identical in-memory transcript, MessagePort structured
// clone, same process/machine. Does not measure recovery, journal IO or providers.
const destination = resolve(process.argv[2] ?? 'scratch/harness-history-transport/report.json');
const ports = new MessageChannel();
const results = [];
async function transfer(value) {
  const start = performance.now();
  const received = new Promise(resolve => ports.port2.once('message', resolve));
  ports.port1.postMessage(value);
  await received;
  return performance.now() - start;
}
try {
  for (const turns of [100, 1_000, 10_000]) {
    const source = { messages: [], rows: [] };
    for (let index = 0; index < turns * 4; index++) {
      const role = ['user', 'assistant', 'tool', 'assistant'][index % 4];
      const content = [{ type: 'text', text: `${index}: ${'x'.repeat(128)}` }];
      source.messages.push({ role, content });
      source.rows.push({ seq: index + 1, role, is_meta: 0, content_json: JSON.stringify(content) });
    }
    for (const kind of ['full', 'tail', 'stats']) {
      const timings = [];
      let bytes = 0;
      let rows = 0;
      for (let sample = 0; sample <= 10; sample++) {
        const started = performance.now();
        const value = kind === 'full' ? source : queryConversationProjection(source,
          kind === 'tail' ? { kind, limit: 10, boundary: 0 } : { kind, boundary: 0 });
        const selectionMs = performance.now() - started;
        const elapsed = selectionMs + await transfer(value);
        if (sample) timings.push(elapsed);
        else { bytes = Buffer.byteLength(JSON.stringify(value)); rows = value.rows.length; }
      }
      timings.sort((a, b) => a - b);
      results.push({ turns, kind, rows, encodedJsonBytes: bytes, samples: timings.length,
        medianMs: timings[Math.floor(timings.length / 2)], p95Ms: timings[Math.ceil(timings.length * .95) - 1] });
    }
  }
} finally { ports.port1.close(); ports.port2.close(); }
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, JSON.stringify({ scope: 'MessagePort transport component, synthetic history',
  date: new Date().toISOString(), node: process.version, platform: process.platform, results }, null, 2));
console.log(JSON.stringify({ destination, results }));
