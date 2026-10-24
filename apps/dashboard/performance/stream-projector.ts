import { randomUUID } from 'node:crypto';
import { TurnProjector } from '../hooks/agent-stream/turn-projector.js';
const round = (ms: number) => Math.round(ms * 1000) / 1000;
function stream(blockCount: number) {
  const projector = new TurnProjector({ sessionId: randomUUID(), updateSession: () => {},
    initialBlocks: Array.from({ length: blockCount }, (_, i) => ({ type: 'tool',
      call: { id: `tool-${i}`, name: 'read_file', status: 'done' } })),
    scheduler: { requestFrame: () => 1, cancelFrame: () => {}, setFallback: (cb, ms) => setTimeout(cb, ms), clearFallback: clearTimeout },
  });
  const start = performance.now();
  for (let i = 0; i < 10_000; i++) projector.dispatch('text', { text: 'x' });
  const elapsedMs = round(performance.now() - start);
  projector.dispose();
  return { existingBlocks: blockCount, deltas: 10_000, handlerMs: elapsedMs, includesDom: false };
}

console.log(JSON.stringify([50, 1_000, 5_000].map(stream)));
