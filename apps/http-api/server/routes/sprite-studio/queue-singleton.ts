/**
 * Process-wide sprite job queue (per-project FIFO, global concurrency 2).
 * Shared by the generate route (enqueue) and cancel route (abort). The queue
 * itself lives in @mcp/sprite-studio; this is just the singleton holder so
 * every request handler enqueues onto the same instance.
 */
import { SpriteJobQueue } from '@mcp/sprite-studio/jobs/queue.js';

let queue: SpriteJobQueue | null = null;

export function getSpriteJobQueue(): SpriteJobQueue {
  if (!queue) queue = new SpriteJobQueue();
  return queue;
}
