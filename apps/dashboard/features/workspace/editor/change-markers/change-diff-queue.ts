import type { Change } from './diff-to-changes.js';
import type { ChangeDiffReply, ChangeDiffRequest } from './change-diff.worker.js';

type Snapshot = Omit<ChangeDiffRequest, 'revision'>;

const createWorker = (): Worker =>
  new Worker(new URL('./change-diff.worker.ts', import.meta.url), { type: 'module' });

export function createChangeDiffQueue(
  read: () => Snapshot | null,
  publish: (changes: Change[]) => void,
  openWorker = createWorker,
) {
  let worker: Worker | null = null;
  let revision = 0;
  let inFlight: number | null = null;
  let queued = false;
  let stopped = false;

  const stop = (): void => {
    stopped = true;
    queued = false;
    inFlight = null;
    worker?.terminate();
    worker = null;
  };

  const fail = (): void => {
    if (stopped) return;
    stop();
    publish([]);
  };

  const pump = (): void => {
    if (stopped || !queued || inFlight !== null) return;
    queued = false;
    const snapshot = read();
    if (!snapshot) return;
    if (snapshot.baseline === snapshot.current) {
      publish([]);
      return;
    }
    try {
      if (!worker) {
        worker = openWorker();
        worker.onmessage = ({ data }: MessageEvent<ChangeDiffReply>) => {
          if (stopped || data.revision !== inFlight) return;
          inFlight = null;
          if (data.revision === revision) publish(data.changes);
          pump();
        };
        worker.onerror = fail;
        worker.onmessageerror = fail;
      }
      inFlight = revision;
      worker.postMessage({ revision, ...snapshot } satisfies ChangeDiffRequest);
    } catch {
      fail();
    }
  };

  return {
    invalidate(): void {
      revision += 1;
      queued = false;
    },
    request(): void {
      queued = true;
      pump();
    },
    dispose: stop,
  };
}