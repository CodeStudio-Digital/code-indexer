import type { IndexTool } from './tool.js';
import { projectTools } from './tools/projects.js';
import { searchTools } from './tools/search.js';
import { fileTools } from './tools/file.js';
import { symbolTools } from './tools/symbols.js';
import { snapshotTools } from './tools/snapshots.js';
import { miscTools } from './tools/misc.js';

/** Every transport-neutral index tool, in the server's published group order. */
export const indexCoreTools: readonly IndexTool[] = [
  ...projectTools,
  ...searchTools,
  ...fileTools,
  ...symbolTools,
  ...snapshotTools,
  ...miscTools,
];
