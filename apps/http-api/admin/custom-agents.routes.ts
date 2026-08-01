import { Hono } from 'hono';
import type { ProviderStore } from '@mcp/store/provider-store.js';
import { AGENTS, type AgentDefinition, type AgentId } from '@mcp/code-agent/agents/index.js';
import { getAllKnownToolsMeta, profileToTiers } from '@mcp/code-agent/tools/tiers.js';
import {
  createCustomAgent,
  CustomAgentValidationError,
  deleteCustomAgent,
  listCustomAgents,
  upsertManagedAgent,
  updateCustomAgent,
  type CustomAgentInput,
  type ManagedAgentInput,
} from '../custom-agents.js';

export function customAgentsRouter(store: ProviderStore): Hono {
  const app = new Hono();

  const purposeTiers: Partial<Record<AgentId, readonly string[]>> = {
    app_db: ['db'],
    api: ['api'],
    diagram: ['diagram'],
  };

  const presetSummary = (preset: AgentDefinition) => {
    const defaultToolTiers = [
      ...profileToTiers(preset.profile),
      ...(purposeTiers[preset.id] ?? []),
    ];
    const active = new Set(defaultToolTiers);
    return {
      ...preset,
      defaultToolTiers,
      defaultToolNames: [...new Set(
        getAllKnownToolsMeta()
          .filter((tool) => active.has(tool.tier))
          .map((tool) => tool.name),
      )],
    };
  };

  app.get('/custom-agents', (c) => c.json({
    agents: listCustomAgents(store),
    presets: Object.values(AGENTS).map(presetSummary),
  }));

  app.post('/custom-agents', async (c) => {
    const body = await c.req.json<CustomAgentInput>().catch(() => null);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);
    try {
      return c.json(createCustomAgent(store, body), 201);
    } catch (error) {
      if (error instanceof CustomAgentValidationError) return c.json({ error: error.message }, 400);
      throw error;
    }
  });

  app.put('/custom-agents/managed/:id', async (c) => {
    const body = await c.req.json<ManagedAgentInput>().catch(() => null);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);
    try {
      return c.json(upsertManagedAgent(store, c.req.param('id'), body));
    } catch (error) {
      if (error instanceof CustomAgentValidationError) return c.json({ error: error.message }, 400);
      throw error;
    }
  });

  app.put('/custom-agents/:id', async (c) => {
    const body = await c.req.json<CustomAgentInput>().catch(() => null);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);
    try {
      const agent = updateCustomAgent(store, c.req.param('id'), body);
      return agent ? c.json(agent) : c.json({ error: 'custom agent not found' }, 404);
    } catch (error) {
      if (error instanceof CustomAgentValidationError) return c.json({ error: error.message }, 400);
      throw error;
    }
  });

  app.delete('/custom-agents/:id', (c) => (
    deleteCustomAgent(store, c.req.param('id'))
      ? c.body(null, 204)
      : c.json({ error: 'custom agent not found' }, 404)
  ));

  return app;
}
