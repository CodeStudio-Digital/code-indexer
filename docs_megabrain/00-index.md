# MegaBrain: Contra-referência Interna do Projeto

Projeto investigado: `CodeStudio/MCP-CodeBase`  
Escopo: arquitetura, agent runtime, tools, indexer/MCP/RAG, UI/Electron/API, store/state, company mode, providers/plugins/cloud/security e telemetry/memory/review.  
Importante: este diretório ainda **não** faz comparativo com projetos externos; ele é a base interna para comparação futura.

## Documentos

- [01-arquitetura-runtime.md](./01-arquitetura-runtime.md) — monorepo, entrypoints, Electron/Hono/API bus, worker pools, docs principais.
- [02-agent-runtime-tools.md](./02-agent-runtime-tools.md) — `packages/code-agent`, runner, prompts, plan/build, tools, subagentes, permissões, metas, memória e compaction.
- [03-company-mode.md](./03-company-mode.md) — company orchestrator, master/subordinates, inbox, board/kanban, sandbox, drive, env/databases e UI.
- [04-indexer-mcp-rag.md](./04-indexer-mcp-rag.md) — indexer, scanning, tree-sitter, symbol graph, vector store, hybrid search, MCP tools e docs RAG.
- [05-ui-electron-api.md](./05-ui-electron-api.md) — dashboard, Electron, `mcp://`, API client, Hono adapters, streaming e superfícies de produto.
- [06-store-state.md](./06-store-state.md) — SQLite, migrations, schema, sessions, telemetry, memory, snapshots, company state e file history.
- [07-providers-plugins-cloud-security.md](./07-providers-plugins-cloud-security.md) — provider SDK/engine, plugin SDK/host/marketplace, cloud API, billing, identity, sync, vault e trust boundaries.
- [08-docs-memory-telemetry-review.md](./08-docs-memory-telemetry-review.md) — DocsAgent, docs bridge, RAG evals, telemetry, snapshot review, memory/snapshot flows.
- [09-operacao-build-verificacao.md](./09-operacao-build-verificacao.md) — comandos reais, scripts, modos de execução, cuidados operacionais e lacunas.

## Síntese executiva

O projeto é um monorepo TypeScript/React/Electron/Cloudflare centrado em uma plataforma AI-native para indexação de código, agentes de coding, MCP tools, dashboard, desktop runtime, company/multi-agent mode, docs/RAG, plugins, providers e cloud services.

A arquitetura principal separa:

- `apps/dashboard`: React SPA e superfícies de produto.
- `apps/electron`: desktop shell, backend in-process, IPC e protocolo `mcp://`.
- `apps/http-api`: Hono adapter para dev/server/browser fallback.
- `apps/mcp-server`: MCP stdio/HTTP server e tools de index/search/symbol/docs.
- `packages/api-bus`: contrato RPC transport-agnostic.
- `packages/api-handlers`: handlers puros reutilizáveis por Electron/Hono/testes.
- `packages/code-agent`: runtime do agente, tool registry, prompts, subagentes e execução.
- `packages/company`: orquestração multi-agent/company mode.
- `packages/indexer`: pipeline de indexação, embeddings, hybrid search e graph data.
- `packages/store`: SQLite, migrations, sessions, telemetry, snapshots e estado persistente.
- `packages/provider-*`: contrato/engine/adapters de providers.
- `packages/plugin-*`: SDK/host/marketplace client de plugins.
- `packages/docs-agent`: deep research sobre corpus documental.
- `services/cloud-api`, `worker`, `worker-market`: cloud backend, embeddings/market e serviços externos.

## Princípios observados

1. **Backend in-process no desktop**: Electron importa o backend e evita loopback HTTP em produção (`apps/electron/main.ts:2-18`).
2. **Contrato antes do transporte**: `@mcp/api-bus` define o contrato; Electron, Hono, SSE e MCP são adaptadores (`packages/api-bus/src/index.ts:2-14`).
3. **Agent runtime tool-first**: ferramentas são contratos runtime com metadados de risco, mutação, sandbox e escopo (`packages/code-agent/src/core/tool.ts:21-109`).
4. **Indexação estrutural + semântica**: scanning, tree-sitter, LLM/summary, embeddings, symbol graph e FTS/vectors trabalham juntos (`packages/indexer/src/indexer/indexer.ts:96-359`).
5. **Estado evolutivo via migrations**: `packages/store` organiza 190+ migrations versionadas e forward-only (`packages/store/src/migrations/index.ts:1-239`).
6. **Company mode como runtime próprio**: master/subordinates, board, inbox, sandbox e drive vivem em `packages/company` (`packages/company/src/orchestrator.ts:82-154`).
7. **Extensibilidade por providers/plugins/MCP**: provider SDK, plugin SDK/host, marketplace e MCP server são superfícies separadas.

## Lacunas ainda úteis para investigação futura

- Mapear cada tool do `packages/code-agent/src/tools` em tabela exaustiva com schema, risco e tier.
- Gerar diagrama completo de todos os namespaces `Api` para rotas Hono e IPC.
- Mapear UI completa por feature folder do dashboard.
- Expandir implementação interna de worker pools e lifecycle de plugin workers.
- Auditar enforce real de permissões vs avisos em comandos shell/subagentes.
