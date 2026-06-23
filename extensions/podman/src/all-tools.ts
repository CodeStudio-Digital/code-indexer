/**
 * Aggregates every Podman tool group into one array for definePlugin. Each
 * group lives in its own ≤200-LOC file and shares the helpers in lib.ts plus
 * the argv/parse functions in @mcp/podman-core.
 */
import { containerTools } from './tools-containers.js';
import { imageTools } from './tools-images.js';
import { volumeTools } from './tools-volumes.js';
import { networkTools } from './tools-networks.js';
import { podTools } from './tools-pods.js';
import { projectTools } from './tools-projects.js';
import { containerizeTools } from './tools-containerize.js';

export const allTools = [
  ...projectTools,
  ...containerizeTools,
  ...containerTools,
  ...imageTools,
  ...volumeTools,
  ...networkTools,
  ...podTools,
];
