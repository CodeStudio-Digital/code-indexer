# Changelog

Todas as mudancas notaveis deste projeto sao documentadas aqui.

O formato segue [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
e o projeto adere a [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.14.0] - 2026-04-08

Rodada 3 do overhaul do coder agent — comparativo contra
[yasasbanukaofficial/claude-code](https://github.com/yasasbanukaofficial/claude-code)
(fork do Claude Code da Anthropic surfacado de sourcemap). Identificadas 8
lacunas reais; aprovadas 5 para implementacao. Foco: dar ao agente
capacidades de alcance externo (web), navegacao por padroes (glob),
eficiencia em refactors (multi-edit), visibilidade de progresso (todo_write +
sidebar), e isolamento de experimentos (worktrees).

### Added

- **Web tools** (`src/core/coder/tools/web.ts`). Tier navigate.
  - **`web_fetch(url)`** — busca uma URL, segue redirects, converte HTML para
    markdown-lite via pipeline de regex in-line (sem adicionar `turndown` como
    dependencia — ~50 linhas cobrem 95% do que o agente precisa). Detecta
    JSON e faz pretty-print. SSRF guard: bloqueia hosts loopback/privados
    (127.*, 10.*, 192.168.*, localhost, ::1). Hard output cap de 15k chars,
    timeout 20s, cache em memoria por URL com TTL de 15min.
  - **`web_search(query, allowed_domains?, blocked_domains?)`** — backend
    plugavel: usa [Brave Search API](https://search.brave.com/app/api)
    (free tier 2000/mes) quando `BRAVE_API_KEY` esta setada, senao cai
    para scraping do DuckDuckGo HTML. Fallback automatico brave → ddg em
    caso de falha. Unwrap de redirects `/l/?uddg=` do DDG. Filtros de
    domain allow/block aplicados post-fetch. Cache similar ao web_fetch.
  - Envs novas: `BRAVE_API_KEY`, `CODER_WEB_OUTPUT_CAP`,
    `CODER_WEB_TIMEOUT_MS`, `CODER_WEB_CACHE_TTL_MS`.

- **Glob tool** (`src/core/coder/tools/glob.ts`). Tier bootstrap.
  - **`glob(pattern, path?, respect_ignore?, limit?)`** — pattern matching
    rapido usando o pacote `glob` ja existente. Respeita `.gitignore` +
    `.mcpindexignore` por default (mesma logica do scanner do indexer).
    Exclusoes built-in imutaveis: `node_modules/`, `.git/`, `dist/`,
    `.mcp-indexer/`. Ordena resultados por mtime descendente — "arquivos
    recentes que casam com X" sai naturalmente. Rejeita patterns absolutos
    (seguranca). Cap de 200 (default) / 1000 (max) paths por call.

- **Multi-edit tool** (novo `multi_edit` em `fs.ts`). Tier navigate.
  - **`multi_edit(path, edits[])`** — aplica N find/replace sequenciais no
    mesmo arquivo em uma unica call. Cada operacao roda contra o resultado
    in-memory da anterior, permitindo que edit #2 case um padrao que so
    existe apos edit #1. Atomico: se qualquer operacao falhar (old_string
    nao encontrado, ambigua sem replace_all), NADA e gravado no disco — o
    arquivo fica intacto e a tool reporta qual op falhou. Reusa
    `CASCADING_REPLACERS` e o matcher cascado do `edit_file`. Max 50 edits
    por call.
  - Helper `performSingleEdit()` extraido para ficar disponivel ao
    multi_edit sem duplicar logica.

- **Todo write tool** (`src/core/coder/tools/todo.ts`). Tier bootstrap.
  - **`todo_write(todos[])`** — checklist user-visible maintained by the
    agent durante uma sessao. Distinto do `submit_tasks` (que PAUSA para
    aprovacao e tem curated file scopes): `todo_write` NUNCA pausa, e
    imperativo, e existe puramente para UX — o dashboard renderiza uma
    sidebar ao lado do chat que atualiza em tempo real via SSE. Cada item
    tem `content` (imperativo), `activeForm` (continuous, para mostrar
    enquanto roda) e `status` (pending/in_progress/completed). Validacao:
    warn soft quando mais de um `in_progress` simultaneo, erro quando
    duplicates, erro quando >50 itens.
  - Novo evento runner `todos_updated` emitido a cada chamada, persistido
    na nova coluna `coder_sessions.todos_json` (migration 013),
    rehidratado no resume de sessao.
  - Novo componente dashboard `TodosSidebar.tsx` com barra de progresso,
    icones Lucide (Check/Circle/Loader2), estado persistido via hook
    `useAgentStream` e re-layout da `<main>` em flex-row para acomodar a
    sidebar sem quebrar o Composer.

- **Worktree tools** (`src/core/coder/tools/worktree.ts`). Tier admin.
  - **`enter_worktree(name?, branch?)`** — cria um git worktree isolado
    em `.mcp-indexer/worktrees/<name>/`, checa out um branch novo
    (default `coder/<name>`) ou existente, e **troca o cwd do runner**
    para o worktree. Todas as tools subsequentes (fs, shell, git, LSP,
    glob) operam contra o worktree. Valida nome (regex), rejeita
    aninhamento, detecta branch existente vs nova (`-b` vs
    plain `add`).
  - **`exit_worktree(action, discard_changes?)`** — restaura o cwd
    original. Com `action:"keep"` deixa o worktree no disco, com
    `action:"remove"` chama `git worktree remove`. Guarda de seguranca:
    se o worktree tem mudancas nao-commitadas, recusa remover a menos
    que `discard_changes:true` seja explicito. Restaura o cwd ANTES de
    `git worktree remove` para evitar race conditions.
  - Runner ganha `originalCwd` + `worktreePath` fields publicos,
    metodos `enterWorktreeScope()` / `exitWorktreeScope()`, e emite
    eventos `worktree_entered` / `worktree_exited`.
  - Migration 013 adiciona `coder_sessions.worktree_path TEXT`.
  - Rehydrate no resume: se o path ainda existe no disco, a sessao
    volta pro worktree automaticamente; se foi deletado externamente,
    a coluna e limpa e um warning e logado.

- **Migration 013 — `coder_todos_and_worktree`**
  (`src/store/migrations/013_coder_todos_and_worktree.ts`). Adiciona duas
  colunas additivas em `coder_sessions`:
  - `todos_json TEXT` — serializacao do estado do `todo_write`.
  - `worktree_path TEXT` — path absoluto do worktree ativo, se houver.

- **Testes novos** (25 casos):
  - `src/__tests__/multi-edit.test.ts` — 6 casos: aplicacao sequencial,
    rollback atomico quando edit #N falha, rejeicao de array vazio,
    deteccao de ambiguidade, `replace_all` per-edit, leitura do resultado
    rolling (edit #2 casa padrao criado por edit #1).
  - `src/__tests__/glob.test.ts` — 8 casos: pattern basico, gitignore
    default, exclusao de node_modules, `respect_ignore:false`, ordenacao
    por mtime, zero matches, rejeicao de patterns absolutos, scoping
    por subdir.
  - Expansao de `src/__tests__/tiers.test.ts` — verifica tier de
    `glob`, `todo_write`, `multi_edit`, `web_fetch`, `web_search`,
    `enter_worktree`, `exit_worktree`. Novos counts: bootstrap 19,
    navigate 38, admin 16.

### Changed

- `CoderRunner`:
  - Novos fields publicos `currentTodos`, `originalCwd`, `worktreePath`.
  - Novos metodos `setTodos()`, `enterWorktreeScope()`, `exitWorktreeScope()`.
  - Novos eventos no `RunnerEvents`: `todos_updated`, `worktree_entered`,
    `worktree_exited`.

- `runCoder()` (`src/core/coder/index.ts`):
  - Registra os 4 novos grupos de tools (`webTools`, `globTools`, `todoTools`,
    `worktreeTools`) alem dos ja existentes.
  - Rehydrate de `todos_json` em `runner.currentTodos` no session load.
  - Rehydrate de `worktree_path` via `runner.enterWorktreeScope()` no
    resume, com guard para paths deletados externamente.
  - Listeners para persistir `todos_updated`, `worktree_entered`,
    `worktree_exited` via novos metodos no `SessionStore`.

- `SessionStore` ganha `setSessionTodos(id, json)` e `setSessionWorktree(id, path)`.

- `CoderSession` type ganha `todos_json: string | null` e `worktree_path: string | null`.

- `src/core/coder/tools/fs.ts`:
  - Extrai helper `performSingleEdit()` para habilitar o multi_edit sem
    duplicar a cascata de matchers. `edit_file` permanece inalterado
    funcionalmente.
  - Novo `multi_edit` tool adicionado ao export `fsTools`.

- `src/core/coder/tools/descriptions.ts`:
  - Adicionado `MULTI_EDIT_DESC` com USE/DON'T pattern.
  - `EDIT_FILE_DESC` ganha uma linha anti-pattern apontando pra multi_edit
    quando houver 3+ edits no mesmo arquivo.

- `src/core/coder/tools/tiers.ts`:
  - Bootstrap: +`glob`, +`todo_write` → **19 tools**.
  - Navigate: +`multi_edit`, +`web_fetch`, +`web_search` → **38 tools**.
  - Admin: +`enter_worktree`, +`exit_worktree` → **16 tools**.
  - Total: **73 tools nativas/admin** (antes: 66).

- Dashboard:
  - Novo componente `features/chat/TodosSidebar.tsx`.
  - `useAgentStream` expoe `todos: TodoItem[]` (novo campo em `SessionState`,
    populado pelo handler `todos_updated`).
  - `AgentChat` re-estruturado: `<main>` contem agora um `<div flex-1>`
    com `[MessageList | TodosSidebar]` em flex-row, seguido do `Composer`
    full-width. Sidebar e `hidden lg:block` — desaparece em telas pequenas.
  - Handler SSE `todos_updated` em `handlers.ts`.

- Migrations: `MIGRATIONS` array no `src/store/migrations/index.ts` ganha
  `coderTodosAndWorktree013` no final.

- README: nao atualizado nesta rodada (sera feito junto com outros cleanups).
- `package.json`: 3.13.0 → **3.14.0**.

### Propostas NAO adotadas

Do catalogo analisado do yasasbanukaofficial/claude-code, as seguintes
capacidades foram avaliadas e rejeitadas por ora:

- **NotebookEdit (.ipynb)** — nicho data science, fora do escopo atual.
  Removida da lista a pedido explicito do usuario.
- **RemoteTrigger / ScheduleCron** — nosso caso de uso e dev-first, nao
  headless SaaS; sobreposicao com o sistema de agents scheduled do proprio
  Claude Code externo.
- **PowerShellTool** — `run_command` ja detecta shell no Windows.
- **REPLTool / SleepTool** — `run_command_pty` cobre REPL interativo.
- **SkillTool / ConfigTool** — config do projeto e estatica
  (`.mcp-indexer.json`); SkillTool e overfit ao ecossistema Anthropic.
- **SendMessage / Team tools** — nao somos multi-user.
- **ToolSearchTool** — redundante com nosso `expand_toolset` + tier system.
- **BriefTool** — 100% sobreposto com nosso `mcp__get_context_for` /
  `mcp__get_project_pulse`.
- **Pattern-based permissions declarativas** — refactor grande do
  `shell.ts` por ganho marginal. Adiado.
- **Aggregate turn output cap** — ganho marginal sobre o cap por bloco
  atual. Adiado.

## [3.13.0] - 2026-04-08

Overhaul da camada de **embeddings e vector search**. Torna o backend
vetorial totalmente modular (Cloudflare/Qdrant/OpenSearch/Pinecone),
adiciona embeddings de snapshots e de bodies de symbols, reindex
incremental por hash, HyDE real com LLM e ferramenta de benchmark de
qualidade de busca.

### Added

- **VectorStore abstraction** (`src/store/vectors.ts`). Interface de 4
  metodos (`upsert`/`search`/`deleteByIds`/`isAvailable`) + factory
  `createVectorStore()` trocando o backend via admin-managed config sem
  quebrar a API. Adapters implementados:
  - `CloudflareVectorStore` (Vectorize via Worker REST) — path legado
    mantido via fallback `.env`.
  - `QdrantVectorStore` — self-hosted, REST nativo, sem SDK. Auto-cria
    collection na primeira escrita com dimensao derivada dos vetores.
    Ids string sao hashados para u63 via FNV-1a (Qdrant so aceita int/UUID).
  - `OpenSearchVectorStore` — backend canonico pro path Bedrock Titan.
    Suporta `es` (Managed) e `aoss` (Serverless), SigV4 via
    `@opensearch-project/opensearch` carregado dinamicamente (dep
    opcional). Index k-NN HNSW com mapping explicito, filter por
    project/type no k-NN query.
  - `PineconeVectorStore` — REST direto ao host da index (sem SDK).
    Namespaces para multi-tenancy, batch upsert em chunks de 100,
    filter Mongo-style (`$eq`), delete em batches de 1000.
  - `NullVectorStore` — fallback grasioso quando nao ha config ativa;
    degrada para FTS-only sem null checks nos callers.
- **Admin config de vector stores** — tabela `vector_store_configs`
  (migration 011) com CRUD via `ProviderStore.listVectorStoreConfigs()`,
  `getDefaultVectorStore()`, `upsertVectorStoreConfig()`. `seedFromEnvIfEmpty()`
  migra legacy `MCP_INDEX_WORKER_URL`, `QDRANT_URL`, `OPENSEARCH_ENDPOINT`,
  `PINECONE_HOST`/`PINECONE_API_KEY` automaticamente no primeiro boot.
  - `GET /api/admin/vector-stores` e `PUT /api/admin/vector-stores/:id`
    (`src/apps/http-api/admin/vector-stores.routes.ts`).
- **Tab "Embeddings & Vector Stores" no dashboard Admin**
  (`src/apps/dashboard/features/admin/`). Lista os configs ativos, mostra
  kind/enabled/default, summary com secrets mascarados. Dialog unificado
  `StorageConfigDialog` com form dinamico por kind (Cloudflare/Qdrant/
  OpenSearch/Pinecone) via `FieldSpec[]`. Usa as rotas ja existentes
  `/api/admin/embeddings` e `/api/admin/vector-stores`.
- **Embeddings de snapshots** (`src/core/services/snapshots.ts`). O
  `SnapshotService` agora recebe `EmbeddingService` + `VectorStore`
  opcionais no construtor; `create/update/delete` disparam
  fire-and-forget para embar e upsertar um vetor `sn_<md5>` com metadata
  minima. `HybridSearch.searchSnapshotsHybrid()` faz FTS + vector RRF
  merge, rehidratando snapshots completos via `db.getSnapshotById()`.
  `query_snapshots` e `get_context_for` passam a usar o path hibrido.
- **Embeddings de symbol bodies** — novo tipo `sb_<md5>` no
  `indexer.processEmbeddings()`. Slice do body extraido do content do
  file (de `sym.line` ate o proximo symbol), com `MCP_INDEX_BODY_MIN_LINES`
  (default 8) e `MCP_INDEX_BODY_MAX_CHARS` (default 2500). Habilita
  `semantic_neighbors` e recall semantico no corpo das funcoes/classes,
  nao so no signature.
- **Reindex incremental via embedding hash** (migration 012). Colunas
  `files.embedding_hash`, `symbols.embedding_hash`, `symbols.body_embedding_hash`
  guardam MD5 do texto embbedado. `processEmbeddings()` skipa reemars
  de conteudo inalterado — tipica reindex incremental so reprocessa
  files que mudaram de verdade.
- **Filtering server-side** nos vector searches. `HybridSearch.vectorSearch`
  passa `filter: {project_name, type}` direto pro backend em vez de
  over-fetch 3x + filtragem client-side. Reduz payload de metadata
  (removidos `text/language/path/kind` dos vetores — ~70% menos bytes)
  e rehidrata do SQLite via `ref_id`.
- **Real HyDE com LLM** (`src/core/search/hyde.ts`). Novo `HyDEService`
  que, dada uma query NL, chama uma provider default (Anthropic ou
  OpenAI-compat) pra gerar um snippet hipotetico de codigo que seria
  uma resposta plausivel, e embba isso como query alternativa. Cache
  LRU de 128 entradas in-process. Fallback gracioso para template-based
  `buildQueryVariants()` quando nao ha provider configurado. Wired em
  `HybridSearch.searchExpanded()` — ativado via `hyde: true` em
  `get_context_for`.
- **`semantic_neighbors` tool** (`src/apps/mcp-server/tools/symbols.ts`).
  Encontra symbols semanticamente similares via os novos vetores
  `sb_` de body. Util para "mostra funcoes parecidas com esta".
- **`vector_coverage` no `get_project_pulse`** — text e JSON output
  mostram `files X% | symbols Y% | bodies N` via
  `db.getEmbeddingCoverage()`, para o agente saber se vector search
  e confiavel naquele projeto antes de tentar.
- **Benchmark de qualidade de busca**
  (`src/benchmarks/search-quality.ts`). Roda um set labeled de queries
  contra um projeto indexado e reporta recall@5/10, MRR e latencia
  mediana/p95 por modo (fts, vector, hybrid, expanded). Aceita JSONL
  externo via `--file` ou usa um set built-in pra rodar out-of-the-box.
  Usage:
  `tsx src/benchmarks/search-quality.ts --project <name> --modes fts,hybrid,expanded`.

### Changed

- **`LLMProvider` nao foi tocada** — HyDE deliberadamente spawna seu
  proprio client minimo a partir do `ProviderStore` (Anthropic SDK ou
  OpenAI SDK via import dinamico), evitando ripple em 6 arquivos de
  provider.
- **`ToolContext`/`ServerDeps`** — `HybridSearch` agora recebe opcional
  `HyDEService` no 4o parametro. Ambos `src/apps/mcp-server/context.ts`
  e `src/apps/http-api/server/deps.ts` wiram automaticamente via o
  `ProviderStore` local.
- **Metadata de vetores** reduzida para `{project_name, type, ref_id}` —
  tudo o que era `text/language/path/kind/name/summary` e rehidratado
  do SQLite quando um match chega. Payload ~70% menor, mesmo recall.

### Schema

- **Migration 011** (`vector_store_configs`): nova tabela com 6 colunas
  (`id`, `kind`, `name`, `enabled`, `is_default`, `config JSON`,
  `updated_at`). Idempotente via `CREATE TABLE IF NOT EXISTS`.
- **Migration 012** (`embedding_hash`): colunas aditivas
  `files.embedding_hash TEXT`, `symbols.embedding_hash TEXT`,
  `symbols.body_embedding_hash TEXT`, todas via `addColumnIfMissing()`.

### Notes

- OpenSearch adapter requer instalacao manual de duas deps opcionais
  (`pnpm add @opensearch-project/opensearch @aws-sdk/credential-provider-node`) —
  mensagem de erro clara no primeiro uso caso falte.
- Pinecone requer index ja criada (com dimensao/metric apropriada)
  pelo usuario no console — ao contrario de Qdrant e OpenSearch, nao
  auto-cria porque Pinecone exige tier/cloud/region escolhidos pelo user.
- O benchmark **nao e cientifico** com o set built-in (so 5 queries);
  use `--file queries.jsonl` pra ter numeros comparaveis entre runs.

## [3.12.0] - 2026-04-08

Overhaul de UX do **dashboard chat** com foco em performance de streaming
e produtividade de navegacao entre sessoes.

### Added

- **Recent sessions globais** na sidebar principal do app
  (`src/apps/dashboard/features/recent/RecentSessionsList.tsx`). Lista
  cross-projeto das sessoes mais recentes; clique navega direto pro
  projeto/sessao. Refetch automatico via evento `coder:sessions-changed`
  disparado por send/create/archive/favorite/fork.
  - Novo endpoint `GET /api/coder/sessions/recent?limit=N` (registrado
    antes das rotas `:id` pra nao colidir com param parser).
  - Novo metodo `SessionStore.listRecentSessionsGlobal()` — JOIN com
    `projects` pra enriquecer com `project_name`.
- **Favoritar sessao** (pin-to-top) com migration `010_session_favorites`
  adicionando `is_favorite`/`favorited_at` + indice composto.
  `listSessions` agora ordena por `is_favorite DESC, updated_at DESC`.
  Botao estrela no `SessionRow` (hover-reveal + amarelo solid quando
  favoritado) e entrada duplicada no DropdownMenu.
  - Novo endpoint `PATCH /api/coder/sessions/:id/favorite`.
  - Novo metodo `SessionStore.setSessionFavorite()`.
- **Fork session from user message** — botao "Fork from here" (icone
  GitBranch) no hover de cada bubble de user em `MessageView`. Cria nova
  sessao com historico ate (exclusivo) a mensagem selecionada, pre-preenche
  o composer com o texto dela pra edicao.
  - Novo endpoint `POST /api/coder/sessions/:id/fork` retornando
    `{ session, seed_text }`.
  - Novo metodo transacional `SessionStore.forkSessionBeforeMessage()`
    que copia mensagens via `INSERT ... FROM coder_messages`, herda
    provider/model/group, e **nao** copia plans/tasks state (slate limpo
    no ponto de fork).
- **Searchable Combobox** (`src/apps/dashboard/components/ui/combobox.tsx`)
  construido sobre `@radix-ui/react-popover` (wrapper novo em
  `popover.tsx`). Filtragem client-side case-insensitive, navegacao por
  teclado (arrows/Enter/Esc), auto-focus do input ao abrir. Substitui os
  `Select` de provider/modelo em `SessionSidebar` e `ComposerToolbar`.

### Changed

- **Tabs de navegacao do ProjectDetail** redesenhadas como segmented pill
  group: container `rounded-full bg-muted`, pills com
  `data-[state=active]:bg-primary` + shadow, icones `h-4`, overflow-x-auto
  em viewports estreitas em vez de wrap.
- **Re-render storm do chat streaming** eliminado
  (`src/apps/dashboard/hooks/agent-stream/openStream.ts`,
  `handlers.ts`, `features/chat/messages/MessageList.tsx`,
  `MessageView.tsx`, `ToolCallBlock.tsx`, `AgentChat.tsx`):
  - Flush do buffer de blocks batched via `requestAnimationFrame`
    (cap de ~60 commits/s contra 50+ tokens/s antes). Eventos terminais
    (`message_complete`/`done`/`error`) fazem `flushNow` sincrono.
  - `MessageList` separado em `<PersistedMessages>` memoizado (historico
    imutavel, nao re-renderiza durante stream) e `<LiveTurn>` isolado.
  - `MessageView` e `ToolCallBlock` agora em `React.memo` com
    comparadores shallow — estado de collapse dos tool calls para de
    resetar durante streaming.
  - Blocks streaming live que estavam comentados no `MessageList` foram
    re-habilitados (antes o custo existia sem render).
  - Scroll durante streaming usa `behavior: 'auto'` (smooth so no final),
    detecta scroll manual pra cima e nao yanka mais o usuario.
  - `AbortController` anterior e abortado antes do novo ser instalado
    (fix pra switch rapido de sessao). `flushHandle` cancelado no finally.
  - `handlers` object em `AgentChat` agora via `useMemo` estavel pra
    preservar a memoizacao de `<PersistedMessages>`.
  - Removido `refetchSession()` redundante em `handleSend` (double-fetch
    por turno).

### Fixed

- `AbortController` podendo vazar em switch rapido de sessao no
  `openStream` (stream antigo continuava consumindo bytes apos o novo ser
  iniciado).
- Estado de collapse do `ToolCallBlock` resetando durante stream por
  falta de `React.memo`.

### Schema

- **Migration 010** (`010_session_favorites`): colunas aditivas
  `is_favorite INTEGER NOT NULL DEFAULT 0` e `favorited_at TEXT` em
  `coder_sessions`; indice
  `idx_coder_sessions_project_favorite_updated(project_id, is_favorite DESC, updated_at DESC)`.
  Idempotente via `addColumnIfMissing()`.

## [3.11.0] - 2026-04-08

Overhaul do **coder agent** inspirado no opencode, mantendo os diferenciais
do indexer (cache telemetry, snapshots, session overlay). Principal ganho:
reducao de ~70% no payload de tools enviado no turno 1 de uma sessao nova
via sistema de tiers, sem perder capacidade — o agente desbloqueia tiers
superiores sob demanda com `expand_toolset`.

### Added

- **Sistema de tiers de tools** (`src/core/coder/tools/tiers.ts`). Tres
  tiers classificando as 66 tools totais:
  - `bootstrap` (17): `mcp__get_project_pulse`, `mcp__search`, `mcp__grep_code`,
    `mcp__get_context_for`, `mcp__query_snapshots`, `mcp__get_file_skeleton`,
    `mcp__read_file`, `mcp__list_directory`, `read_file`, `list_directory`,
    `ask_user`, `submit_plan`, `submit_tasks`, `expand_toolset`,
    `get_tool_output`, `mcp__list_projects`, `mcp__get_project_stats`.
  - `navigate` (+35): write/edit/create_file, `run_command`, `run_command_pty`,
    `get_diagnostics`, `lsp_definition`, `lsp_references`, `lsp_hover`,
    `lsp_diagnostics`, git_status/diff/log, spawn_subagent, execute_task,
    task_complete, `mcp__find_references`, `mcp__trace_usage`,
    `mcp__get_dependencies`, `mcp__get_dependents`, `mcp__get_symbol_body`,
    `mcp__prepare_edit`, `mcp__get_class_members`, etc.
  - `admin` (+14): `git_add`, `git_commit`, `git_branch`, `mcp__index_project`,
    `mcp__delete_project`, `mcp__add_snapshot`, `mcp__update_snapshot`,
    `mcp__delete_snapshot`, `mcp__get_costs`, `mcp__estimate_cost`,
    `mcp__list_models`, `mcp__export_docs`, `mcp__get_diff`,
    `mcp__get_snapshot_history`.
  - `filterByTiers()` preserva a ordem de entrada (cache-stable). Tiers
    crescem monotonicamente — uma vez promovidos, nunca encolhem mid-sessao.
- **`expand_toolset` tool** (`src/core/coder/tools/expand.ts`). Escape
  hatch runtime: o agent chama `expand_toolset({tier: "navigate", reason})`
  quando percebe que precisa de tools fora do bootstrap. Chama
  `runner.promoteTier()` — o tools array e reconstruido no inicio do
  proximo turno. O cache prefix quebra UMA vez e re-estabiliza.
- **Profiles** (`bootstrap | navigate | full | auto`). Nova opcao
  `RunCoderOptions.profile`, flag `--profile` no CLI, env `CODER_PROFILE`.
  Default: `bootstrap` para sessoes novas, `full` para resumidas. Modo
  `auto` usa `inferProfileFromMessage()` — regex heuristic sub-ms que
  roteia "commit/push/branch" → full, "refatore/implemente/fix/add" →
  navigate, exploracao → bootstrap.
- **Agent presets de primeira classe** (`src/core/coder/agents/index.ts`).
  Quatro presets bundlando profile + plan mode + max_turns:
  - `explore` — bootstrap, sem plan mode, 30 turnos. Read-only.
  - `plan` — navigate + plan mode ON. Exploracao + aprovacao de plano.
  - `build` — navigate, sem plan mode. Execucao direta de pequenas tasks.
  - `admin` — full, sem plan mode. Inclui git mutations, snapshot admin.
  Nova flag `--agent <id>` no CLI. `RunCoderOptions.agent` tem precedencia
  sobre `profile`/`planMode` quando os explicitos nao estao setados.
- **LSP Phase 2 — in-process TypeScript language service**
  (`src/core/coder/lsp/ts-service.ts`). Usa o TypeScript Compiler API
  diretamente (nao spawna tsserver) — mesmo motor do VSCode, ~10x mais
  rapido que LSP-over-stdio porque nao tem IPC. Um `TsLanguageService` por
  projeto, cached entre sessoes, com versionamento por mtime. Quatro tools
  publicas no tier navigate:
  - `lsp_definition(file, line, column)` — go-to-definition semantico.
  - `lsp_references(file, line, column)` — find usages com flag `[write]`.
  - `lsp_hover(file, line, column)` — tipo inferido + JSDoc.
  - `lsp_diagnostics(file)` — syntactic + semantic por arquivo.
  Coordenadas **1-based** para bater com editores/stack traces. 7 testes
  de integracao em `src/__tests__/lsp-service.test.ts` exercitam o
  compiler real contra um projeto TS sintetico em temp dir.
- **`get_diagnostics` tool (Phase 1)** (`src/core/coder/tools/diagnostics.ts`).
  Shell-out generico pra linguagens fora de TS/JS: `tsc --noEmit` (ts/js),
  `ruff check` ou `python -m py_compile` (py), `go vet ./...` (go),
  `cargo check` (rs). Cache por mtime — repeticoes no mesmo arquivo sao
  gratis.
- **`run_command_pty` tool** (`src/core/coder/tools/pty.ts`). Execucao
  shell num pseudo-terminal real via `node-pty`. **Dynamic import** — nao
  adiciona dependencia forte, retorna erro com instrucoes de instalacao
  quando ausente. Suporta `stdin: string[]` para alimentar prompts
  interativos sequencialmente. Hard timeout + cap de output previnem
  REPLs travados/floods.
- **Tool output side-files** (`src/core/coder/overlay/tool-output-store.ts`).
  Outputs >`PUSH_TIME_CAP` sao gravados em
  `.mcp-indexer/coder/tool-outputs/{session}/{hash}.txt`, com `output_id`
  (primeiros 12 chars do sha256) embutido deterministicamente no marker
  de truncagem. Nova tool `get_tool_output({output_id})` no tier bootstrap
  recupera o conteudo integral sob demanda. GC automatico de arquivos >7
  dias (configuravel via `CODER_TOOL_OUTPUT_TTL_DAYS`). IDs content-hashed
  garantem determinismo — outputs identicos produzem IDs identicos.
- **LLM summarizer de compaction (opt-in)**
  (`src/core/coder/core/summarizer.ts` + `prompts/summarize.txt`). Quando
  `CODER_SUMMARIZER_ENABLE=1` e o historico excede `PRUNE_MINIMUM`, o runner
  dispara uma vez por sessao um summarizer LLM que substitui o span antigo
  por **uma** mensagem sintetica com JSON estruturado
  (`what_done`, `current_work`, `files_touched`, `decisions`, `next_steps`,
  `user_preferences`). Fallback robusto: qualquer falha (LLM timeout, JSON
  invalido) cai no path deterministico `compactMessages` existente. O DB
  persistente nunca e tocado — so `runner.messages` in-memory.
- **Anti-pattern tool descriptions**. Reescrita de
  `src/core/coder/tools/descriptions.ts` no estilo opencode
  (`USE` / `DON'T`). Ex: `run_command` agora explicita "DON'T: cat/head/tail
  → use read_file. DON'T: grep/rg → use mcp__grep_code. DON'T: sed/awk →
  use edit_file. DON'T: npm run dev → timeout + wasted tokens". Reducao
  substancial de roteamento errado sem aumentar o payload.
- **Prompts em arquivos .txt** (`src/core/coder/prompts/`). `base.txt`,
  `plan.txt`, `summarize.txt`. `system-prompt.ts` virou um montador/
  interpolador via `loader.ts` — editar prompts nao exige rebuild. Cache
  em memoria; em dev, `CODER_PROMPTS_WATCH=1` faz hot-reload via fs.watch.
  Novo script `scripts/copy-prompts.mjs` rodado no postbuild copia os
  `.txt` para `dist/core/coder/prompts/` (tsc nao copia non-.ts). Fallback
  do loader le da source tree quando o .txt nao esta no dist.
- **Capability-aware tool filtering**
  (`src/core/coder/providers/capabilities.ts`). Mapa `model → {maxTools, note}`
  embutido: `claude-opus-4-6`/`claude-sonnet-4-6` 200, `glm-5.1` 50
  ("confusao acima de ~50 tools"), `deepseek-chat` 40, `gpt-4o-mini` 64.
  Aplicado apos tier filtering — se o tier retorna mais tools que o model
  aguenta, o tail e cortado (least-valuable-first). Override via env
  `CODER_MODEL_CAPS` (JSON).
- **Plugin hooks por projeto** (`src/core/coder/core/hooks.ts`).
  `.mcp-indexer/hooks/system-prompt.js` exporta `(ctx) => string` appendado
  ao prompt final. `.mcp-indexer/hooks/tool-filter.js` exporta
  `({tools, ctx}) => string[]` — allowlist final aplicada apos tier +
  capability cap. Ambos rodam em `node:vm` sandbox com timeout 200ms;
  falhas logam warning e nao quebram a sessao. Scripts cached por project
  root.
- **Novos endpoints HTTP**:
  - `GET /api/coder/agents` — lista os 4 presets + `TIER_COUNTS`, consumido
    pelo dashboard pra popular o AgentPicker.
  - `POST /api/coder/classify-intent` `{message}` →
    `{agent, profile, confidence}` — regex heuristic sub-milissegundo.
  - `sendMessage` / `continue` agora aceitam `agent` e `profile` no body,
    propagados para `runCoder`.
- **Dashboard AgentPicker**
  (`src/apps/dashboard/features/chat/composer/AgentPicker.tsx`). Combobox
  compacto na toolbar do chat com icones (Compass/ClipboardList/Hammer/
  ShieldAlert). Busca a lista de agents do server no mount. Enquanto o
  usuario digita, roda debounced (350ms) `POST /classify-intent` e mostra
  um link `✨ try build` clicavel quando a heuristica recomenda um agent
  diferente — nunca muta a selecao sozinho. Plumbed via `ComposerToolbar`
  → `Composer` → `AgentChat` → `useAgentStream.sendMessage({agent})`.
- **CLI flags**:
  - `--agent <id>` — `explore | plan | build | admin`.
  - `--profile <id>` — `bootstrap | navigate | full | auto`, override do
    preset do agent.
- **Envs novas**:
  - `CODER_PROFILE` — profile default sem precisar passar `--profile`.
  - `CODER_LOG_TOOLS_COUNT=1` — loga contagem de tools por turno.
  - `CODER_SUMMARIZER_ENABLE=1` — liga o summarizer opt-in.
  - `CODER_TOOL_OUTPUT_TTL_DAYS` — GC dos side-files (default 7).
  - `CODER_MODEL_CAPS` — override do capability map (JSON).
  - `CODER_PROMPTS_WATCH=1` — hot-reload de prompts em dev.
- **Testes**:
  - `src/__tests__/tiers.test.ts` — 13 casos: tier counts travados,
    classificacao por nome, `filterByTiers` preserva ordem,
    `inferProfileFromMessage` routing.
  - `src/__tests__/agents.test.ts` — 7 casos: 4 presets, guardas de tipo,
    summary rendering.
  - `src/__tests__/lsp-service.test.ts` — 7 casos de integracao com o TS
    Compiler real (projeto sintetico em temp dir, getDefinition,
    getReferences, getHover com JSDoc, getDiagnostics com erro proposital,
    path normalization).

### Changed

- `CoderRunner.run()` agora reconstroi o `tools` array **dentro** do loop,
  regido por um `activeTiers: Set<ToolTier>` e recalculado quando a chave
  muda (`currentKey !== lastTiersKey`). Antes era construido uma vez antes
  do loop. `buildTools()` aplica: tier filter → hook filter → capability
  cap → map pra shape do provider.
- `buildToolResultBlock()` aceita parametro opcional `outputId` e inclui
  `output_id=XYZ, call get_tool_output("XYZ")` no marker quando o runner
  persistiu o conteudo no store lateral.
- `ToolContext` ganha `toolOutputStore?: ToolOutputStore` — undefined em
  subagents e testes (graceful degradation).
- `buildSystemPrompt()` agora le `base.txt` + opcionalmente `plan.txt` via
  `loadPrompt()`, interpola `{{projectName}}`, `{{projectRoot}}`, `{{os}}`,
  `{{tierHint}}`. Nova funcao `tierHint(profile)` emite um bloco estavel
  explicando os tiers ocultos quando o profile nao e `full`. Footer do
  hook de projeto appendado ao final (sandbox vm).
- `McpToolBridge.listTools()` mantem o sort alfabetico (cache-stable) e
  passa pelo filtro de `CODER_DISABLED_MCP_TOOLS` como antes — os tiers
  sao aplicados depois no runner, nao no bridge, pra permitir promocao
  mid-sessao sem reconectar.
- `package.json` ganha `scripts/copy-prompts.mjs` no `build` e `build:all`
  para que o dist contenha os `.txt`.
- README: titulo para v3.11, nova secao "Novidades v3.11 — Coder Agent
  overhaul" cobrindo tiers, agents, LSP, side-files, summarizer,
  `run_command_pty`, anti-pattern descriptions, prompts .txt, hooks,
  capability filter, endpoints novos, tabela de envs, contagem por tier.
- CLAUDE.md titulo para v3.11.
- `package.json` version: 3.10.0 → **3.11.0**.

### Performance / token economy

- Turno 1 de sessao nova com profile bootstrap: **~17 tools** (antes: ~57).
  Reducao de ~70% no schema de tools enviado ao LLM. Para sessoes curtas
  informacionais ("explique X"), essa reducao persiste por toda a sessao —
  o bootstrap nunca precisa expandir.
- Apos promocao para navigate, o prefix cache re-estabiliza do turno
  seguinte em diante (monotonic append-only).
- Capability cap evita que modelos fracos (GLM, DeepSeek) recebam tools
  que comprovadamente causam confusao de nome.
- Summarizer opt-in: span de 20 mensagens antigas (~25k chars) vira ~500
  tokens de resumo estruturado. Reducao de ~50x no footprint, preservando
  decisions / files touched / next steps.

## [3.10.0] - 2026-04-08

OAuth para provedores de assinatura (**GitHub Copilot Individual/Business/
Enterprise** e **ChatGPT Plus/Pro/Team via Codex PKCE**), com suporte
completo tanto no **coder agent** quanto no **indexer**. Lista de modelos
unificada — o indexer agora puxa dos mesmos `provider_models` que o admin
UI exibe, eliminando a divergência entre os dois.

### Added
- **Copilot Enterprise (GHES)** no admin OAuth. `src/admin/oauth/copilot.ts`
  parametriza edition, `ghes_host`, `integration_id` e `client_id`. Device
  flow e `/copilot_internal/v2/token` são resolvidos por edition:
  individual → `github.com` + `api.github.com`, enterprise →
  `${ghes_host}/login/device/code` + `${ghes_host}/api/v3/...`. O dialog
  do admin ganha picker **Individual/Business** vs **Enterprise (GHES)**
  com mini-form pra host + integration_id.
- **OAuth ChatGPT (Codex PKCE)** novo — `src/admin/oauth/openai.ts` com
  fluxo PKCE S256 contra `auth.openai.com`, servidor loopback one-shot em
  `127.0.0.1:1455` (captura o callback, responde HTML e fecha), refresh
  de access_token via grant_type=refresh_token, helper
  `extractAccountIdFromIdToken()` pra decodificar `chatgpt_account_id`
  do JWT. Params do authorize URL casam o Codex CLI /
  opencode (`id_token_add_organizations`, `codex_cli_simplified_flow`,
  `originator`). Rotas `/oauth/openai/start` e `/oauth/openai/poll` no
  admin API; botão **Connect ChatGPT** no admin dashboard.
- **`ChatGPTCodexProvider`** (`src/coder/providers/chatgpt.ts`) — novo
  adapter para o coder que usa **Responses API** (`client.responses.create`),
  não `/chat/completions`. Converte `AgentMessage[]` → `input[]` da
  Responses API (role=user/assistant com `input_text`/`output_text`,
  `function_call`, `function_call_output`), tools com `strict: false` e
  `parallel_tool_calls: false`, `store: false`. Parser de stream mapeia
  eventos `response.output_text.delta`, `response.output_item.added`,
  `response.function_call_arguments.delta/.done`, `response.completed`,
  `response.error`/`.failed` → `ChatDelta`. Headers `ChatGPT-Account-Id`,
  `originator: codex_cli_rs`, `User-Agent: codex_cli_rs/0.1.0`,
  `session_id` (UUID por instância).
- **`ChatGPTProvider` single-shot no indexer** (`src/agent/providers/chatgpt.ts`) —
  versão single-shot do mesmo adapter para `analyzeFile()`. Usa
  `responses.create({stream:false})`, extrai `output_text` ou varre
  `output[].content[]` pra recuperar o texto, devolve
  `{analysis, inputTokens, outputTokens}`.
- **`createProviderAsync` / `createProviderFromConfigAsync`** no agent
  factory (`src/agent/providers/factory.ts`) — versões async que fazem
  refresh de token Copilot/ChatGPT antes de instanciar o adapter.
  Helpers `buildCopilotAgentProvider` (injeta `copilotHeaders()` no
  `OpenAIProvider` + baseURL de `extra.endpoints.api`) e
  `buildChatGPTAgentProvider` (extrai account_id, instancia
  `ChatGPTProvider`).
- **Parâmetro `defaultHeaders`** nos constructors de
  `src/coder/providers/openai.ts` e `src/agent/providers/openai.ts`,
  repassado pro OpenAI SDK. Permite que os wrappers Copilot/ChatGPT
  injetem headers sem duplicar Authorization (SDK cuida via apiKey).

### Changed
- **Lista de modelos do indexer** agora lê de `provider_models` via
  `ProviderStore.listModels()` (mesma fonte do admin UI). O método
  `ModelDiscovery.discoverModels()` prefere a tabela antes de cair no
  path legacy (cache + live fetch + hardcoded). Impacta `GET /api/models`,
  `mcp__list_models` e o comando `models` do CLI — todos convergem com
  o que aparece na aba Admin.
- **Callers do indexer** (`src/api/server.ts:99`, `src/cli.ts:268,576`,
  `src/mcp/server.ts:241`) migrados para `createProviderAsync`, que
  agora aceita kinds OAuth (`copilot`, `chatgpt`) transparentemente —
  antes esses kinds crashavam com *"Unsupported provider kind for
  indexer"*.
- **`ProviderKind`** estendido com `'chatgpt'` em
  `src/store/provider-store.ts`.
- **`discoverModels()` do admin** separa branches `copilot` e `chatgpt`
  do branch `openai`. Copilot refresca token antes do fetch, usa
  `copilotHeaders()` + `endpoints.api` do exchange; ChatGPT retorna
  seed hardcoded (Codex backend não expõe `/models` pra tokens OAuth,
  mesma estratégia do opencode e Codex CLI).
- **Seed de modelos ChatGPT** (`CHATGPT_SEED_MODELS`) casa o allowlist
  do opencode: `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`, `gpt-5.2`,
  `gpt-5.2-codex`, `gpt-5.1-codex`, `gpt-5.1-codex-max`,
  `gpt-5.1-codex-mini`.
- **Admin dialog do Copilot** chama `loadModels(provider_id)`
  automaticamente no `status='authorized'`, eliminando o passo manual
  de clicar refresh pra popular a lista.

### Fixed
- **Model fetch do Copilot quebrado** — `discoverModels()` agrupava
  `copilot` no branch `openai`, usava `base_url ?? 'https://api.openai.com/v1'`
  (default errado), e mandava só `Authorization: Bearer` sem os headers
  obrigatórios (`Editor-Version`, `Editor-Plugin-Version`,
  `Copilot-Integration-Id`, `User-Agent`) que o Copilot API exige. Além
  disso não chamava `refreshIfExpired()`, então o token de 25min ficava
  morto depois do primeiro refresh. Agora branch dedicado refresca,
  resolve base via `endpoints.api`, usa `copilotHeaders()`.
- **Indexer crashava em provider_configs com kind=chatgpt** com
  *"Unsupported provider kind for indexer"*. O agent factory antigo só
  aceitava `anthropic`/`openai`/`gemini`/`bedrock(throw)`. Agora os
  kinds OAuth são resolvidos assincronamente com token refresh.

## [3.9.0] - 2026-04-08

Refator estrutural completo do **frontend do dashboard** seguindo regras
feature-first com cap de **300 linhas por arquivo**. Os 4 ofensores
(`AgentChat.tsx` 1646L, `Admin.tsx` 829L, `useAgentStream.ts` 573L,
`ProjectDetail.tsx` 494L) foram quebrados em **79 arquivos** organizados por
domínio em `src/dashboard/features/`. Zero mudança de comportamento, zero
mudança de API HTTP/SSE — apenas reorganização e UX de diálogos.

### Changed
- **Reorganização feature-first** de `src/dashboard/components/*` →
  `src/dashboard/features/{chat,admin,project,search,snapshots,diff,costs}/`.
  Cada feature tem `index.ts` (barrel só com a exportação pública), imports
  internos relativos. `components/ui/` (shadcn primitives) permanece como está.
- **`AgentChat.tsx` (1646L → 273L)** quebrado em 22 arquivos no
  `features/chat/`:
  - Shell: `AgentChat.tsx` (orquestração + handlers), `SessionSidebar.tsx`,
    `ChatHeader.tsx`, `EmptyChatState.tsx`, `SessionDetailsModal.tsx`
  - `composer/`: `Composer.tsx` + `ComposerToolbar.tsx`
  - `messages/`: `MessageList.tsx`, `MessageView.tsx`, `AssistantBubble.tsx`,
    `CopyMarkdownButton.tsx`, `Markdown.tsx`, `renderStreamBlock.tsx`,
    `ToolCallBlock.tsx`
  - `prompts/`: `PlanPromptView.tsx`, `QuestionPromptView.tsx`,
    `TaskListReview.tsx`, `TaskRow.tsx`
  - Lógica colocada: `useAgentChatState.ts` (effects de providers/stats/tasks),
    `types.ts`, `constants.ts` (PROVIDERS, providerAccent/Label), `utils.ts`
    (formatDuration, fileToAttachment, getCurrentTurnText/...)
- **`Admin.tsx` (829L → 141L)** quebrado em 9 arquivos no `features/admin/`:
  - Shell: `Admin.tsx`, `ProviderCard.tsx`
  - Diálogos: `EditDialog.tsx`, `BedrockCredentialsDialog.tsx`,
    `CopilotConnectionDialog.tsx`, `ChatgptConnectionDialog.tsx`
  - Lógica: `hooks/useAdminProviders.ts` (state CRUD/test/refresh), `api.ts`
    (fetch helpers puros), `types.ts`
- **`ProjectDetail.tsx` (494L → 139L)** quebrado em 9 arquivos no
  `features/project/`: shell + `StatCard.tsx` + `ProjectList.tsx` (relocado) +
  `tabs/{FilesTab,FileDetailModal,DependenciesTab,ArchitectureTab,RunsTab}.tsx`
  + `types.ts`.
- **`useAgentStream.ts` (573L → 207L shell + 5 arquivos)** quebrado em
  `src/dashboard/hooks/agent-stream/`:
  - `types.ts` (todas as interfaces + `ZERO_DELTA`/`EMPTY_STATE`)
  - `handlers.ts` (mapa de event handlers SSE — 10 eventos)
  - `openStream.ts` (parser SSE com `Last-Event-ID`)
  - `useAgentStream.ts` (hook shell + `postAndResume` helper compartilhado por
    `answerQuestion`/`respondToPlan`/`respondToTasks`)
  - `index.ts` (barrel)
  - `hooks/useAgentStream.ts` original virou um **shim de re-export** de 19
    linhas — `AgentChat`/`ToolCallBlock` continuam importando do mesmo path
    sem churn.
- **Pequenos componentes relocados** sem alteração de lógica, apenas paths:
  `ProjectList`, `SearchPanel`, `SnapshotEditor`, `DiffViewer`,
  `CostDashboard`, `SessionDetailsModal`, `ToolCallBlock` movidos para suas
  features correspondentes.
- **`App.tsx`** atualizado para importar de `./features/{admin,project}` e
  envolver o app no `<DialogProvider>`.

### Added
- **`components/ui/dialog-provider.tsx`** — `<DialogProvider>` global + hooks
  `useConfirm()` / `useNotify()` que retornam `Promise<boolean>` /
  `Promise<void>`. Substitui `window.alert()` / `window.confirm()` por
  diálogos shadcn elegantes com 4 variants (`info`/`success`/`warning`/
  `destructive`), ícone, descrição opcional, labels customizáveis, focus
  automático e fechamento por ESC/overlay.
- **5 sites trocados** para usar o novo provider:
  - `AgentChat.handleDelete` → confirm destrutivo "Delete this session?"
  - `SnapshotEditor.handleDelete` → confirm destrutivo "Delete this snapshot?"
  - `useAdminProviders.remove` → confirm destrutivo "Delete provider {id}?"
  - `useAdminProviders.save` → notify destrutivo "Save failed"
  - `useAdminProviders.refresh` → notify destrutivo "Refresh failed"

### Removed
- **10 arquivos antigos** em `src/dashboard/components/` (Admin.tsx,
  AgentChat.tsx, CostDashboard.tsx, DiffViewer.tsx, ProjectDetail.tsx,
  ProjectList.tsx, SearchPanel.tsx, SessionDetailsModal.tsx, SnapshotEditor.tsx,
  ToolCallBlock.tsx) — todo o código vivo agora em `features/`.
- Todas as chamadas a `window.alert()` / `window.confirm()` nativos.

### Compliance com regras de front
- Maior arquivo agora: **277L** (`SnapshotEditor.tsx`); todos os 79 arquivos
  ≤ 300L. Verificado com
  `find src/dashboard -name '*.tsx' -o -name '*.ts' | xargs wc -l | awk '$1>300 && $2!="total"'`.
- **Feature-first**: organização por domínio, não por tipo.
- **Barrel exports**: cada feature expõe só seu componente público em `index.ts`;
  imports internos são relativos.
- **Props tipadas**: toda boundary tem `interface ___Props` nomeada, zero `any`
  introduzido.
- **`.tsx` vs `.ts`**: 55 `.tsx` (com JSX) + 24 `.ts` (lógica/tipos puros).
- **Hooks colocados**: `useAgentChatState` vive em `features/chat/` (consumidor
  único), `useAdminProviders` em `features/admin/hooks/`. Apenas
  `useApi`/`useAgentStream` permanecem em `hooks/` (compartilhados).

### Verification
- `npx vite build --config src/dashboard/vite.config.ts` → **2187 modules
  transformed, built in 3.17s** ✓
- Line-count gate ✓
- Backend, API HTTP, SSE protocol, sessões persistidas: **inalterados**.

## [3.8.0] - 2026-04-08

Foco em **resiliência do streaming do dashboard, persistência de planos/tarefas
e UX da aba Chat**. O run do coder agora sobrevive ao usuário fechar a aba, os
planos viram entidade de primeira classe na DB e o header do chat ganhou modal
de detalhes da sessão.

### Added
- **Stream reattach**: novo `src/api/coder-bus.ts` com event bus por sessão
  (ring buffer `BUFFER_CAP=2000`, `publish/subscribe/markEnded/waitEnded`).
  `runCoder` agora roda em background desacoplado do request HTTP — se o
  cliente fecha a aba, o run continua produzindo eventos no buffer.
- **`GET /api/coder/sessions/:id/attach`**: SSE de reattach com replay via
  `Last-Event-ID`. O dashboard reanexa automaticamente ao selecionar uma
  sessão com run ativo.
- **`GET /api/coder/sessions/:id/status`**: probe `{ active, last_seq }` para
  o auto-reattach.
- **TTL de 30s pós-`done`** no `activeRuns` map: permite reattach tardio de
  runs que terminaram entre o fechar e reabrir da aba.
- **Migration 007 (`coder_plans`)**: tabela dedicada para planos do
  `submit_plan`. Campos: `session_id`, `tool_use_id` (UNIQUE), `plan_text`,
  `status` (`pending`/`approved`/`rejected`/`aborted`), `feedback`,
  `created_at`, `resolved_at`. Cascata `ON DELETE` da sessão. `INSERT … ON
  CONFLICT(tool_use_id) DO UPDATE` para idempotência em resume.
- **Migration 008 (`coder_tasks`)**: tabela `coder_tasks_state` (estado JSON
  do `submit_tasks`/`execute_task`/`task_complete`) para o pipeline de tarefas
  do coder agent.
- **`SessionStore.recordPlan/resolvePlan/listPlans/getPlan`** + tipos
  `CoderPlanRow`, `CoderPlanStatus` em `src/coder/sessions/types.ts`.
- **`SessionStore.recordTasks/resolveTasks/updateTaskStatus/getTasksState`** +
  tipos `CoderTask`, `TasksState`, `TaskExecutionMode`, `CoderTasksRow`.
- **`ToolContext.recordPlan/resolvePlan`** (e equivalentes para tasks): hooks
  opcionais injetados pelo `runCoder` que delegam ao `SessionStore`. A tool
  fica agnóstica de persistência (testes sem store seguem funcionando).
- **`GET /api/coder/sessions/:id/plans`**: lista planos persistidos da sessão
  ordenados por `created_at desc`.
- **`POST /plan-response` agora atualiza `coder_plans`**: o resume path
  (após server restart) também chama `sessionStore.resolvePlan(...)` para o
  status persistido refletir o veredito do usuário.
- **`SessionDetailsModal.tsx`** (novo): modal `Dialog 2xl` com `Tabs`:
  - **Resumo** — tokens (input/output/cache read/cache write/hit rate/savings)
    + atividade (mensagens, turnos, tool calls, errors, distinct tools,
    subagentes, tempo em tools, duração).
  - **Planos** — lista colapsável dos planos persistidos com badge de status
    colorido (pendente/aprovado/rejeitado/abortado), markdown expansível
    via `ReactMarkdown + remarkGfm`, botão "Copiar markdown" e exibição do
    feedback do usuário.
- **Botão `Info` no header da conversa** (`AgentChat.tsx`): tooltip
  "Detalhes da sessão", abre o `SessionDetailsModal`.
- **Botão "Copiar markdown" por mensagem** (`CopyMarkdownButton`): aparece
  no hover do header `assistant`, copia todos os blocos `text` concatenados.
- **Auto-reattach no client**: novo `useEffect` em `AgentChat` que faz probe
  em `/status` no mount de sessão e abre `/attach` quando há run ativo.
- **`useAgentStream.openStream`** generaliza o antigo `runStream` para
  aceitar GET + `Last-Event-ID`. Novo `reattach(sid)` reusa o pipeline.
  `SessionState` ganhou `lastSeenSeq` e `reattached`.
- **Parser SSE** agora lê `id:` e propaga para `lastSeenSeq` (suporte a
  reconexão incremental).

### Changed
- **`POST /messages` e `POST /continue`** refatorados: o `runCoder` é
  disparado fire-and-forget, listeners do runner publicam no bus via
  `wireRunnerToBus()` e o `streamSSE` apenas subscribe + `waitEnded`.
- **`POST /abort`** agora atua sobre `bus.ctrl/runner` em vez do antigo
  `runEntry`.
- **Sidebar de sessões** (`AgentChat.tsx`): título com `truncate` +
  `Tooltip` exibindo o título completo no hover. Botão de delete
  (`MoreHorizontal`) sempre visível (antes era `opacity-0
  group-hover:opacity-100` e ficava inalcançável quando o card overflowing).
- **`useAgentStream message_complete`**: limpa `currentTurn` antes de
  chamar `onMessageComplete`, fechando race que duplicava o layout durante
  o streaming.
- **`AgentChat.handleSend`**: refetch por turno restaurado com segurança
  (o reorder no hook fechou o race original).

### Fixed
- **Layout duplicado durante streaming**: turnos persistidos apareciam ao
  mesmo tempo que o `currentTurn` por causa de race entre `setState` do
  clear e `refetchSession`.
- **Histórico sumindo entre turnos**: ao enviar prompts multi-turno, só o
  último turno aparecia no chat até o `done` final disparar o refetch.
- **Botão de delete inacessível** quando o título da sessão estourava o
  card no sidebar.
- **`done` event do runner com erro**: o hook agora extrai `error` do
  payload do `done` (a UI ficava silenciosa antes).

## [3.7.0] - 2026-04-07

Foco em **visibilidade de cache e métricas de sessão no dashboard**. Os ganhos
de cache da v3.5/3.6 (78-99% de hit rate em ZAI/GLM) agora são persistidos e
exibidos retroativamente — sobrevivem a F5, restart e abertura de sessões
antigas.

### Added
- **Migration 005 (`coder_cache_tokens`)** — colunas aditivas e idempotentes
  (`PRAGMA table_info` antes de cada `ALTER TABLE`):
  - `coder_sessions.total_cache_read_tokens`, `total_cache_creation_tokens`
  - `coder_messages.cache_read_tokens`, `cache_creation_tokens`
  Sessões antigas continuam funcionando com defaults 0.
- **`SessionStore.getSessionStats(id)`** — método novo que computa em SQLite
  via 3 queries enxutas: tokens (input/output/cache_read/cache_creation),
  contagens (mensagens, turnos assistente, tool calls, errors, distinct
  tools, subagentes), `total_tool_duration_ms` e `duration_ms` da sessão
  (calculado via `julianday`). Retorna `CoderSessionStats`.
- **`GET /api/coder/sessions/:id/stats`** — endpoint HTTP novo que expõe o
  `CoderSessionStats`. Usado pelo dashboard para popular o tooltip do header.
- **Header `⚡` retroativo** em `AgentChat.tsx` — agora lê
  `total_cache_read_tokens` da DB (sobrevive a reload) somado ao delta
  runtime (`useAgentStream.runDelta`) durante sessões ativas.
- **Tooltip expandido do header** — input/output/cache read/cache write,
  **hit rate %**, **~tokens economizados** (cached × 0.5, baseado no pricing
  de ZAI/GLM e Anthropic), último turno e métricas do `/stats` (mensagens,
  turnos, tool calls, errors, distinct tools, subagentes, tempo em tools,
  duração total).
- **Badge `⚡N` per-message** no `MessageView` — aparece em verde ao lado do
  `↑X ↓Y` quando o assistant message usou cache.
- **`useAgentStream.runDelta`** — novo estado por sessão, acumula
  `cache_read_input_tokens` e `cache_creation_input_tokens` a cada
  `message_complete` durante o run, resetado a cada `sendMessage`/`runStream`.

### Changed
- **`SessionStore.bumpUsage()`** — assinatura estendida para 5 args
  (`cacheRead` e `cacheCreation` default 0). Backwards-compatible.
- **`SessionStore.appendMessage()`** — aceita `cache_read_input_tokens` e
  `cache_creation_input_tokens` no objeto `usage` e persiste nas novas
  colunas.
- **`runCoder` (`src/coder/index.ts`)** — duas chamadas `bumpUsage` (turno
  assistente em `message_complete` e subagente em `tool_call_result`) agora
  passam os campos de cache, garantindo que o cache acumulado por
  subagentes seja contado no totalizador da sessão pai.
- **Tipos `CoderSession` e `CoderMessageRow`** estendidos com os 4 campos
  novos. Novo tipo `CoderSessionStats` em `src/coder/sessions/types.ts`.

### Verified
- Sessão real no projeto `whatsapp-pro-api`: 131k input, 107k cache_read
  persistidos = **81% de hit rate retroativo**, com `getSessionStats`
  retornando `subagent_call_count=1`, `total_tool_duration_ms=101538`,
  `duration_ms=133999`.
- 68/68 testes verdes (db.test.ts atualizado para schema v5).

---

## [3.6.0] - 2026-04-07

Foco em **resiliência da camada interativa do Coder Agent** e em corrigir o
bug de duplicação no stream do dashboard.

### Added
- **Resume de sessões interativas pós-restart** — `submit_plan` e `ask_user`
  agora sobrevivem a restart do servidor, refresh da página e fechamento da
  aba. `POST /api/coder/sessions/:id/plan-response` e `/answer` ganharam um
  caminho de fallback que detecta o `tool_use` pendente na história persistida
  (via `findPendingInteraction`) e injeta o `tool_result` correspondente direto
  no DB, retornando `{ resumed: true }`.
- **`POST /api/coder/sessions/:id/continue`** — novo endpoint SSE que continua
  uma sessão a partir do `tool_result` recém-injetado pelo resume path. Espelha
  `/messages` mas chama `runCoder({ resume: true })`, sem empurrar nova
  mensagem do usuário.
- **`runCoder({ resume: true })`** — pula a inserção da mensagem do usuário,
  re-aplica `approvePlan()` quando o último `tool_result` é uma aprovação, e
  ajusta `lastPersistedIdx` para não persistir o tool message duas vezes.
- **Helpers `formatPlanResult` / `formatAskUserResult`** em
  `src/coder/tools/plan.ts` e `src/coder/tools/interaction.ts` — produzem o
  conteúdo do `tool_result` byte-idêntico entre o handler in-process e o
  caminho de resume, preservando o cache de prefixo.

### Fixed
- **Duplicação no stream do chat** (`useAgentStream.ts`) — o buffer local de
  blocos não era resetado entre turnos internos do mesmo `sendMessage`. Após
  cada `message_complete` a mensagem persistida era re-renderizada via
  `refetchSession()`, mas o buffer ainda guardava os tool calls do turno
  anterior, fazendo o turno seguinte renderizar `[turno N + turno N+1]` por
  cima da MessageView já persistida. Agora o handler de `message_complete`
  zera `blocks`, `toolIndex` e o `currentTurn`.

### Changed
- **`useAgentStream.runStream`** — extraído de `sendMessage`; é o núcleo de
  pump SSE compartilhado por `sendMessage` (POST `/messages`) e pelo novo
  caminho de resume (POST `/continue`). `answerQuestion` e `respondToPlan`
  detectam `{ resumed: true }` na resposta e abrem automaticamente a stream
  de continuação.

---

## [3.5.0] - 2026-04-06

### Changed
- **Truncamento monótono no push-time** dos `tool_results`
  (`buildToolResultBlock`) em `src/coder/core/runner.ts` substitui a antiga
  janela deslizante. Cada bloco é truncado uma única vez no momento da
  criação com marcador determinístico, preservando o cache de prefixo
  (Anthropic ephemeral, ZAI/GLM auto cache).
- **`normalizeMessageForCache`** re-aplica o cap em mensagens legadas no
  resume da sessão para manter o prefixo bit-stable.
- Logs de cache hit por turno: `[coder] turn=N input=X output=Y cache_hit=Z
  ratio=W%`, com warning quando o ratio cai abaixo de 40% após o turno 3.

### Added
- Env vars `CODER_PUSH_TIME_CAP`, `CODER_TURN_BUDGET_CHARS`,
  `CODER_MCP_OUTPUT_HARD_CAP`, `CODER_READ_FILE_HARD_MAX`,
  `CODER_MCP_DEFAULT_MAX_TOKENS`, `CODER_DISABLED_MCP_TOOLS`,
  `CODER_TERSE_TOOLS` para tuning de tokens sem rebuild.

---

## [3.4.0] - 2026-04-05

### Added
- **Coder Agent** (`src/coder/`) — agente de programação multi-provider sobre
  as 41 tools de leitura. Native tools (`write_file`/`edit_file`/
  `run_command`/git), bridge MCP via stdio, sessões persistidas
  (`coder_sessions`, `coder_messages`, `coder_tool_calls` — migration 004),
  CLI `mcp-code-indexer agent`, aba **Chat** no dashboard com streaming SSE,
  picker de provider/modelo por sessão e botão Abort.
- **Plan mode** — tool `submit_plan` exige aprovação explícita antes de
  tools mutativas (`write_file`, `edit_file`, `create_file`, `run_command`,
  `git_*`).
- **Tool `ask_user`** — pausa o run e pede uma decisão ao usuário (free-form
  ou opções pré-definidas).
- **Subagent tool** (`spawn_subagent`) — delega exploração para um sub-runner
  isolado; usage acumula no contador da sessão pai.
- Endpoints HTTP: `GET /api/coder/providers`, CRUD de `/api/coder/sessions`,
  `POST /messages` (SSE), `/abort`, `/answer`, `/plan-response`, `/switch`.

---

## [3.3.0] - 2026-04-06

Ciclo focado em confianca (versao unica, testes), corretude (precisao de simbolos,
invalidacao de snapshots, limpeza de abstracoes) e eficiencia (limites de token
garantidos, respostas estruturadas).

### Added
- **Migrations de schema** — tabela `schema_version` e runner em `src/store/migrations/`.
- **Identidade estavel de simbolos** — coluna `symbols.stable_id` baseada em
  `kind + name + parent + signature_hash` (sem `line`, que muda a cada edicao).
- **Desambiguacao de simbolos** — `find_references`, `get_symbol_body`,
  `prepare_edit`, `get_hierarchy` aceitam `file_path` e `symbol_id`.
- **Snapshots com referencias de arquivo** — tabela `snapshot_files` com hash
  no momento da criacao; queries retornam `stale: true` quando divergem.
- **Token budget util** — `src/utils/token-budget.ts` centraliza estimativa
  e truncamento por tokens estimados (nao por chars).
- **Limites explicitos** — `get_project_overview` (`max_files`),
  `get_file_skeleton` (`max_symbols`), `prepare_edit` (`max_callers`);
  cada resposta truncada inclui `truncated: true` e dica de expansao.
- **Cap em `prepare_edit`** — callers ordenados por proximidade
  (mesmo arquivo > mesmo dir > resto), truncados com `total_callers`/`shown`.
- **Respostas estruturadas** — parametro `format: "text" | "json"` em
  `get_file_skeleton`, `prepare_edit`, `find_references`, `query_snapshots`,
  `get_project_pulse`, `get_symbol_body`.
- **Custos separados** — `cost_llm_analysis` vs `cost_embeddings`, e
  `cost_estimated` vs `cost_actual`; `get_project_pulse` mostra
  `cost_per_file_avg`.
- **Resolver de imports melhorado** — aliases de `tsconfig.compilerOptions.paths`,
  `index.ts/js`, extensoes multiplas (.ts/.tsx/.js/.jsx/.mts/.cts).
- **Suite de testes (vitest)** — cobertura inicial em `src/__tests__/`:
  db, fts, scanner, code-reader, providers/base, hybrid search, round-trip
  de indexacao e contrato MCP.
- **CHANGELOG.md** — este arquivo.

### Changed
- **Versao unificada para 3.3.0** em `package.json`, `src/cli.ts`,
  `src/mcp/server.ts`, `README.md` e `CLAUDE.md`.
- **`minimatch` como dependencia direta** em `package.json` (antes vinha
  apenas via transitiva, quebrando installs limpos).
- **CLAUDE.md** sincronizado com contagem real de 41 tools.

### Fixed
- **Remocao de `(db as any).db.prepare(...)`** em `src/mcp/server.ts`
  (linhas 733, 863, 868). Substituidos por metodos publicos de
  `CodeIndexDB`: `findSymbolByName`, `findSymbolsInFile`.
- **Symbol lookup por nome simples** — agora retorna candidatos quando
  ambiguo, em vez de chutar o primeiro match.

### Migration notes
- DBs existentes sao migrados automaticamente na primeira abertura apos
  upgrade. A migration `001_baseline` registra o schema atual como versao 1.
- `002_symbol_stable_id` popula `stable_id` para rows existentes.
- `003_snapshot_files` adiciona a tabela de referencias; snapshots antigos
  continuam funcionando sem flag de stale (por nao terem referencias
  registradas).
