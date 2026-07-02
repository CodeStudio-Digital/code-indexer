# Store, Estado e Persistência

## Visão geral

`packages/store` é o núcleo de persistência local do projeto. Ele usa SQLite, WAL, migrations forward-only e um conjunto grande de domínios: projetos, arquivos, símbolos, snapshots, memory, coder sessions, tool calls, telemetry, company sessions, board, envs, sandboxes, reviews, local file history e docs.

A arquitetura posiciona `@mcp/store` como dono de SQLite/WAL e migrations; no Electron, o build embute o binário nativo SQLite e requer rebuild para ABI Electron (`docs/ARCHITECTURE.md:139-150`).

## Migration runner

O migration runner central importa e ordena 190+ migrations, rastreia versão em `schema_version` e documenta `outsideTransaction` para rebuilds de tabela com foreign keys desligadas (`packages/store/src/migrations/index.ts:1-239`). O padrão observado é forward-only, versionado e explicitamente ordenado (`packages/store/src/migrations/index.ts:12-16`).

Muitas migrations são defensivas/aditivas, usando `PRAGMA table_info` antes de `ALTER TABLE ADD COLUMN`, como em coder todos, goals, telemetry, user memory, snapshot archive e telemetry project id (`packages/store/src/migrations/013_coder_todos_and_worktree.ts:22-25`, `packages/store/src/migrations/068_coder_session_goal.ts:19-22`, `packages/store/src/migrations/138_run_phase_telemetry.ts:13-16`, `packages/store/src/migrations/145_user_memory.ts:23-26`, `packages/store/src/migrations/146_snapshot_archive.ts:19-22`, `packages/store/src/migrations/162_telemetry_project_id.ts:20-23`).

O projeto também evolui por novas junction/audit tables e partial indexes, como session file snapshots, snapshot reviews e global sessions (`packages/store/src/migrations/079_session_file_snapshots.ts:54-95`, `packages/store/src/migrations/110_session_snapshot_reviews.ts:32-57`, `packages/store/src/migrations/152_global_sessions.ts:45-66`). Há migrations de descontinuação real, como `191_retire_company_session_databases`, que purga secrets, dropa tabela e enriquece history para preservar lineage (`packages/store/src/migrations/191_retire_company_session_databases.ts:45-72`).

## Base schema

A base schema define tabelas centrais como `projects`, `files`, `symbols`, `runs`, `snapshots`, `agent_memory`, `agent_memory_events`, `costs`, `webhooks`, `file_snapshots`, `vector_ids`, `models_cache`, `file_concepts`, `file_dependencies`, `symbol_references`, `symbol_relations` e `snapshot_versions` (`packages/store/src/db/schema/tables.ts:3-269`).

O schema usa indexes parciais/cobridores para memória viva e cobertura de embeddings, incluindo `idx_agent_memory_live_name` e `idx_files_project_embedding` (`packages/store/src/db/schema/tables.ts:236-252`). Comentários indicam compatibilidade de bootstrap: tabelas base já incluem colunas adicionadas por migrations posteriores, para fresh DBs e migrated DBs convergirem (`packages/store/src/db/schema/tables.ts:38-43`).

## FTS

FTS espelha tabelas base de `files`, `symbols`, `snapshots` e `agent_memory`, com triggers de insert/delete e caminho de rebuild/repair para corrupção FTS (`packages/store/src/db/schema/fts.ts:4-75`). `doc_chunks_fts` é condicional à existência de `doc_chunks`; cria triggers insert/delete/update e backfill se FTS está vazia (`packages/store/src/db/schema/fts.ts:125-166`). Comentários reforçam que derived indexes podem ser reconstruídos das source tables (`packages/store/src/db/schema/fts.ts:104-123`).

## Project DB split

`project-db/project-schema.ts` reutiliza o mesmo schema central e migrations centrais, depois remove storage que não é project-only (`packages/store/src/project-db/project-schema.ts:1-33`). O DB principal também suporta split lazy de INDEX tables para DB por projeto, e split de vectors separado após relational split (`packages/store/src/db.ts:314-346`).

## Files, snapshots e local history

Upserts de arquivo atualizam row base + FTS, recalculam concept rows e persistem `mtime_ms` opcional; snapshots entram em `file_snapshots` (`packages/store/src/db/files.ts:32-100`). O scanning stat-first usa `mtime_ms` para backfill/touch behavior (`packages/store/src/db/files.ts:128-146`). File snapshot writes são append-only por run (`packages/store/src/db/files.ts:177-190`).

Local file history é content-addressed por MD5 do conteúdo normalizado, refcounted em `file_history_blobs`; revisões são podadas por idade/cap, mas labels `manual` são protegidos (`packages/store/src/file-local-history-store.ts:14-166`). A migration de file history usa `file_history_blobs` e `file_local_history`, deduped por hash (`packages/store/src/migrations/160_file_local_history.ts:24-57`).

## Symbols e graph persistence

`stable_id` foi adicionado aos símbolos para identidade determinística entre reindexações, derivado de `projectId:filePath:kind:parent:name:signature` e SHA-1 (`packages/store/src/migrations/002_symbol_stable_id.ts:2-15`, `packages/store/src/migrations/002_symbol_stable_id.ts:39-51`).

O store de symbols apaga symbols/relações antigas do arquivo e insere os novos com `stable_id`, além de relações `extends`, `implements` e PHP `mixes` (`packages/store/src/db/symbols.ts:14-67`). Relações em `symbol_references` e `symbol_relations` alimentam callers, hierarchy, implementors, subclasses e usage tracing (`packages/store/src/db/symbol-relations.ts:13-163`).

## Coder sessions, tool calls, todos e goals

A persistência de coder começa com `coder_sessions`, `coder_messages` e `coder_tool_calls`; tool calls persistem args, result, status e duration (`packages/store/src/migrations/004_coder_sessions.ts:21-63`). Sessions ganharam `todos_json` e `worktree_path` (`packages/store/src/migrations/013_coder_todos_and_worktree.ts:4-15`). Goals persistentes adicionaram `goal_text`, `goal_status`, budget, completion note e timestamps (`packages/store/src/migrations/068_coder_session_goal.ts:4-12`).

Global sessions adicionaram `is_global`, junction `coder_session_projects` e index parcial (`packages/store/src/migrations/152_global_sessions.ts:43-66`). Essa modelagem permite sessões globais vinculadas a múltiplos projetos.

## Telemetry

`coder_turn_telemetry` registra session/run/turn, tokens, tool counts, compaction flags e lista serializada de tools (`packages/store/src/migrations/069_coder_turn_telemetry.ts:24-54`). Tool-call telemetry evoluiu com output size, truncation, phase e join key para turn telemetry; turn telemetry ganhou tamanho de system prompt/tools def e custo por turno (`packages/store/src/migrations/072_telemetry_per_tool.ts:42-79`).

Metadados de request/response foram adicionados depois, com índices por request model e response status (`packages/store/src/migrations/093_turn_request_response_meta.ts:22-53`). `visible_tools_count` foi acrescentado (`packages/store/src/migrations/135_model_max_tools.ts:9-29`). Runs ganharam `phase_timings_json` e `peak_rss_mb` (`packages/store/src/migrations/138_run_phase_telemetry.ts:23-24`). `coder_turn_telemetry` ganhou `project_id` denormalizado para central telemetry continuar queryable após split de DB por projeto (`packages/store/src/migrations/162_telemetry_project_id.ts:2-44`).

A agregação global de telemetry calcula totais de sessions/turns, cobertura de custos, top tools, phase breakdown e top sessions a partir das tabelas de coder telemetry (`packages/code-agent/src/sessions/store/telemetry-global.ts:84-310`). Rotas HTTP expõem admin global telemetry, refresh/backfill de model prices e summaries/turn rows por sessão (`apps/http-api/server/routes/telemetry.ts:20-92`).

## Session file snapshots e review

Session snapshots são divididos em active baselines, edits append-only e hunk decisions. Baselines usam chave `(session_kind, session_id, file_path, project_id IS ?)` para multi-project sessions (`packages/store/src/session-file-snapshot-store.ts:23-257`). A migration cria `session_file_baselines`, `session_file_edits` e `session_file_hunk_decisions`, com índices para active baseline e uniqueness de hunks (`packages/store/src/migrations/079_session_file_snapshots.ts:38-95`).

Snapshot review persistence adiciona `session_file_review_runs` e `session_file_review_comments` vinculados a baselines (`packages/store/src/migrations/110_session_snapshot_reviews.ts:18-57`). O review store persiste runs/comments com status, severity, diff excerpts e sent-state (`packages/store/src/session-file-review-store.ts:60-230`).

## Memory e snapshots

Snapshots evoluem para project memory por colunas de provenance, importance e access (`packages/store/src/migrations/114_snapshot_memory.ts:27-31`). User-scoped memory é introduzida adicionando `scope` a snapshots e seedando projeto oculto `id = 0`, `name = '__user__'` (`packages/store/src/migrations/145_user_memory.ts:33-39`). Snapshot archive/soft-delete usa `archived_at` e `archived_reason`, com live-row index (`packages/store/src/migrations/146_snapshot_archive.ts:29-34`).

A base schema inclui `agent_memory` e `agent_memory_events`, com FTS para memória (`packages/store/src/db/schema/tables.ts:3-269`, `packages/store/src/db/schema/fts.ts:4-75`).

## Company state

`CompanyStore` pode abrir sua própria conexão SQLite ou reutilizar uma shared; quando possui o path, habilita WAL e foreign keys (`packages/store/src/company-store.ts:43-64`). CRUD de company session é delegado a módulos de domínio para status, config, recovery flag e child sessions (`packages/store/src/company-store.ts:75-88`). `getCompanySessionFull` agrega session, projects, agent runs, board entries recentes e master prompts recentes (`packages/store/src/company-store.ts:113-129`).

A base company schema cria `company_templates`, `company_sessions`, `company_session_projects`, `company_agent_runs` e `company_board` (`packages/store/src/migrations/018_company_agents.ts:26-77`). Env vars de sessão ficam em `company_session_envs`, com primary key `(session_id, key)` (`packages/store/src/migrations/036_company_session_envs.ts:27-49`). Provenance `source` foi adicionada com enum `{user, imported, auto, agent}` (`packages/store/src/migrations/039_company_session_env_source.ts:31-35`).

`company_session_env_store` preserva `service_scope` existente salvo override explícito; upsert é tri-state para scope: `undefined` preserva, `null` limpa, string normaliza/armazena. `onlyIfAbsent` permite import insert-only (`packages/store/src/company-session-env-store.ts:19-117`).

A registry antiga de session databases guardava labels, provider, primary flag, env key mapping e metadata (`packages/store/src/migrations/040_company_session_databases.ts:34-60`), mas foi aposentada por migration que purga secrets referenciados, dropa tabela e adiciona `source` a `db_query_history` (`packages/store/src/migrations/191_retire_company_session_databases.ts:45-72`).

## Vectors

`vector_ids` registra IDs com `INSERT OR REPLACE`, tornando reindex idempotente (`packages/store/src/db/vectors.ts:12-28`). A tabela suporta listing por projeto, orphan detection, stats por type e deletes chunked/deduped com pending deletes em falha remota (`packages/store/src/db/vectors.ts:30-158`).

## Design choices observados

- O schema favorece evolução incremental e compatibilidade fresh/migrated DB.
- FTS é derivada e reparável.
- Snapshots e reviews são append-oriented e auditáveis.
- Telemetry ganhou granularidade por turno, tool, fase, custo e projeto.
- Company mode persiste estado próprio, mas compartilha conexão/store.
- User memory é modelada como extensão de snapshots com projeto oculto.
- Project DB split existe, mas mantém compatibilidade por schema/migrations compartilhadas.
