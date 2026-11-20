import { CodeIndexDB } from '@mcp/store/db.js';
import { loadConfig, type IndexerConfig } from '@mcp/shared/utils/config.js';
import { ExportService } from '@mcp/services/services/exporter.js';
import { WebhookDispatcher } from '@mcp/services/services/webhooks.js';
import {
  createIndexToolContext,
  type IndexToolContext,
} from '@mcp/indexer/agent-tools/context.js';

/** Index tool services plus what only the application/CLI surface needs. */
export interface ToolContext extends IndexToolContext {
  config: IndexerConfig;
  exportService: ExportService;
  webhookDispatcher: WebhookDispatcher;
}

export function buildContext(): ToolContext {
  const config = loadConfig();
  const db = new CodeIndexDB(config.dbPath);

  return {
    config,
    ...createIndexToolContext(config, db),
    exportService: new ExportService(db),
    webhookDispatcher: new WebhookDispatcher(db),
  };
}
