/**
 * Aggregates every Cloudflare tool group into one array for definePlugin.
 * Each group lives in its own ≤200-LOC file and reuses the shared helpers in
 * lib.ts (cfFetch / cfAcct / wrangler / detectCloudflare / ok / fail / list).
 */
import { tools as coreTools } from './tools.js';
import { kvTools } from './tools-kv.js';
import { r2Tools } from './tools-r2.js';
import { secretTools } from './tools-secrets.js';
import { queueTools } from './tools-queues.js';
import { vectorizeTools } from './tools-vectorize.js';
import { miscTools } from './tools-misc.js';
import { pagesTools } from './tools-pages.js';
import { dnsTools } from './tools-dns.js';
import { cacheTools } from './tools-cache.js';
import { deployTools } from './tools-deploys.js';

export const allTools = [
  ...coreTools,
  ...kvTools,
  ...r2Tools,
  ...secretTools,
  ...queueTools,
  ...vectorizeTools,
  ...miscTools,
  ...pagesTools,
  ...dnsTools,
  ...cacheTools,
  ...deployTools,
];
