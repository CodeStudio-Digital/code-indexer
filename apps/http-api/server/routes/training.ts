import type { Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { createTrainingHandlers, createContext, MCP_BLOCK_SERVER_KEY } from '@mcp/api-handlers';
import { ApiError, type StartDatasetInput, type TrainingSettingsDTO } from '@mcp/api-bus';
import { AppSettingsStore } from '@mcp/store/app-settings-store.js';
import type { ServerDeps } from '../deps.js';
import { parseIdParam, parseJsonBody, notFound } from './_helpers.js';
import { getGlobalMcpExternalPool } from '../../sse/McpExternalPool.js';

/**
 * Call a tool on the MCP server the user picked as the block source (persisted
 * in AppSettings). Falls back to discovering whichever connected server exposes
 * the tool, so it works before the user makes an explicit choice.
 */
function makeMcpCall(dbPath: string) {
  const settings = new AppSettingsStore(dbPath);
  return async function mcpCall(toolName: string, args: Record<string, unknown>): Promise<string> {
    const pool = getGlobalMcpExternalPool();
    if (!pool) throw new Error('MCP pool unavailable');
    const snapshot = pool.getSnapshot();
    const chosen = settings.getRaw(MCP_BLOCK_SERVER_KEY);
    const tool =
      (chosen && snapshot.tools.find((t) => t.serverId === chosen && t.toolName === toolName)) ||
      snapshot.tools.find((t) => t.toolName === toolName);
    if (!tool) throw new Error(`No connected MCP server exposes "${toolName}"`);
    const r = await pool.callTool(tool.serverId, toolName, args);
    if (!r.ok) throw new Error(r.text);
    return r.text;
  };
}

/**
 * Hono routes for /api/training/* (Phase A: dataset generation). Thin
 * adapters over `@mcp/api-handlers/training`. The dataset job streams progress
 * over SSE, mirroring the indexer's /index/stream route.
 */
function mapApiError(c: Context, err: unknown) {
  if (err instanceof ApiError) {
    return c.json({ error: err.message, code: err.code }, err.status as never);
  }
  throw err;
}

export function mountTrainingRoutes(app: Hono, deps: ServerDeps): void {
  const h = createTrainingHandlers(deps, { mcpCall: makeMcpCall(deps.config.dbPath) });

  app.get('/api/training/profiles', async (c) => {
    try {
      return c.json(await h.profiles(undefined, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.get('/api/training/mcp-servers', async (c) => {
    try {
      return c.json(await h.mcpServers(undefined, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.get('/api/training/collections', async (c) => {
    try {
      return c.json(await h.collections(undefined, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.get('/api/training/settings', async (c) => {
    try {
      return c.json(await h.getSettings(undefined, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.put('/api/training/settings', async (c) => {
    try {
      const body = (await parseJsonBody<TrainingSettingsDTO>(c)) as TrainingSettingsDTO;
      return c.json(await h.setSettings(body, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.get('/api/training/projects/:id/datasets', async (c) => {
    try {
      return c.json(await h.listDatasets({ projectId: parseIdParam(c) }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.get('/api/training/datasets/:id', async (c) => {
    try {
      return c.json(await h.getDataset({ id: parseIdParam(c) }, createContext()));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return notFound(c);
      return mapApiError(c, err);
    }
  });

  app.delete('/api/training/datasets/:id', async (c) => {
    try {
      return c.json(await h.deleteDataset({ id: parseIdParam(c) }, createContext()));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return notFound(c);
      return mapApiError(c, err);
    }
  });

  app.get('/api/training/datasets/:id/examples', async (c) => {
    try {
      const limit = Number(c.req.query('limit') ?? '50');
      return c.json(await h.listExamples({ id: parseIdParam(c), limit }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/training/datasets/start/stream', async (c) => {
    const body = (await parseJsonBody<StartDatasetInput>(c)) as StartDatasetInput;
    return streamSSE(c, async (stream) => {
      let seq = 0;
      try {
        for await (const ev of h.startDatasetStream(body, createContext())) {
          await stream.writeSSE({ id: String(seq++), event: ev.event, data: JSON.stringify(ev.data) });
        }
      } catch (err) {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ datasetId: 0, message: err instanceof Error ? err.message : String(err) }),
        });
      } finally {
        await stream.close();
      }
    });
  });
}
