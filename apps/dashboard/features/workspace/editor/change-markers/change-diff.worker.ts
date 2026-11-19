import { computeChanges, type Change } from './diff-to-changes.js';

export interface ChangeDiffRequest {
  revision: number;
  baseline: string;
  current: string;
}

export interface ChangeDiffReply {
  revision: number;
  changes: Change[];
}

self.onmessage = ({ data }: MessageEvent<ChangeDiffRequest>) => {
  const reply: ChangeDiffReply = {
    revision: data.revision,
    changes: computeChanges(data.baseline, data.current),
  };
  self.postMessage(reply);
};