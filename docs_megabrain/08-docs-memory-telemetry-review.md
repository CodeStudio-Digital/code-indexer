# Docs, Memória, Telemetry e Review

## Visão geral

O projeto possui uma camada robusta para pesquisa documental, memória, telemetry e revisão de snapshots. As superfícies principais são:

- `packages/docs-agent`: agente especializado em deep research sobre docs.
- `packages/code-agent/src/tools/rag-search-docs.ts`: busca/leitura RAG exposta ao agente.
- `apps/http-api/server/routes/company/docs*.ts`: docs de company session e ingestão RAG.
- `packages/store`: stores de docs research, snapshots, memory, telemetry e review.
- `packages/services/src/services/snapshot-review-pipeline.ts`: pipeline de review automatizado.
- `scripts/docs-rag-eval.ts`: benchmark de retrieval documental.

## DocsAgent lifecycle

`runDocsAgent()` cria uma linha `docs_research_sessions` imediatamente, registrando trigger, parent coder session, query e collections (`packages/docs-agent/src/index.ts:79-89`). O toolset é estreito e docs-only: plan, list sources, search, read chunk, synthesize e finish (`packages/docs-agent/src/index.ts:137-152`).

O agente resolve binding `docs_research/scorer_llm`, monta o system prompt a partir das collections atuais, constrói um `CoderRunner` e injeta a query do usuário como primeira mensagem (`packages/docs-agent/src/index.ts:153-183`). Se `docs_finish` foi chamado, o resultado passa por fidelity review gate, é persistido como `completed` com telemetry e chunk IDs citados (`packages/docs-agent/src/index.ts:197-239`). Se o runner sai sem `docs_finish`, a sessão é finalizada como `failed` ou `aborted` com resultado sintético de erro (`packages/docs-agent/src/index.ts:242-264`).

Falhas persistem empty citations, low confidence e telemetry derivada de counters + token usage do runner (`packages/docs-agent/src/index.ts:340-381`). A biblioteca reexporta session store, toolset builder e citation helpers, indicando que `DocsAgent` é camada de composição sobre retrieval/persistência (`packages/docs-agent/src/index.ts:386-409`).

## Fidelity review gate

O review gate hidrata chunks citados, checa a resposta contra fontes e pode aplicar repair; pode ser desligado por `DOCS_REVIEW_GATE=0` (`packages/docs-agent/src/index.ts:288-317`). A implementação executa uma passada de modelo forte sobre a resposta final e degrada para pass em qualquer falha operacional (`packages/docs-agent/src/review/review-gate.ts:66-83`).

`applyReview()` substitui markdown por repair, reduz confidence e adiciona nota de review quando o reviewer retorna verdict de repair (`packages/docs-agent/src/review/review-gate.ts:91-103`). O prompt de review exige JSON puro e verifica claims contra cited passages e sub-questions opcionais (`packages/docs-agent/src/review/review-gate.ts:135-149`).

## Tools do DocsAgent

O toolset incrementa counters por run: buscas, chunks lidos, syntheses, tokens e custo (`packages/docs-agent/src/tools/index.ts:48-80`). `docs_plan` guarda sub-questions ordenadas em slot mutável, limitado a 8 itens (`packages/docs-agent/src/tools/docs-plan.ts:30-69`). `docs_finish` valida markdown, chunk IDs e confidence, grava o payload final no slot e aborta o runner para encerrar a investigação (`packages/docs-agent/src/tools/docs-finish.ts:38-117`).

## Bridge de deep research

`DocsResearchBridge.runResearch()` é a ponte do host para `runDocsAgent()` (`packages/docs-agent/src/bridges/docs-bridge.ts:53-70`). O deep-research documental é instalado como singleton de processo via `setGlobalDocsResearcher()` / `getGlobalDocsResearcher()` (`packages/docs-agent/src/bridges/docs-bridge.ts:75-87`).

`docs_deep_research` é a tool exposta ao coder agent; valida input, cai para `rag_search_docs` se a bridge não existe, roda subagente e retorna markdown com resumo de chunks citados (`packages/docs-agent/src/bridges/docs-bridge.ts:96-180`). `installDocsDeepResearch()` registra a tool em um runner existente via registry interno (`packages/docs-agent/src/bridges/docs-bridge.ts:187-223`).

## RAG search de docs

No code-agent, doc search usa backend singleton configurado por `setGlobalDocSearch()` (`packages/code-agent/src/tools/rag-search-docs.ts:46-52`). `rag_search_docs` permite busca escopada ao projeto ou ao corpus inteiro, diferencia explicitamente no-good-match/no-results e retorna chunk IDs para leitura posterior (`packages/code-agent/src/tools/rag-search-docs.ts:54-184`).

No MCP server, `rag_search_docs` é uma tool read-only que consulta o singleton global de doc-search e devolve source, heading, snippet e metadata; se o singleton não estiver conectado, retorna erro claro de indisponibilidade (`apps/mcp-server/tools/docs.ts:1-95`).

## Company docs e ingestão RAG

A API de company docs lista arquivos do sandbox e entradas duráveis espelhadas do drive, incluindo `origin` para provenance (`apps/http-api/server/routes/company/docs.ts:112-179`). A leitura cai de sandbox para drive mirror, devolvendo `origin` e `mtime` (`apps/http-api/server/routes/company/docs.ts:139-192`).

A rota docs-to-RAG ingere um company doc na pipeline real, linka a collection ao projeto e chama `runIngest(..., { skipGate: true })` (`apps/http-api/server/routes/company/docs-rag.ts:84-147`). A rota de status reporta se há `doc_sources` com status `done` para o doc (`apps/http-api/server/routes/company/docs-rag.ts:149-167`).

## Docs research sessions store

`DocsResearchSessionsStore` suporta create/get/list/complete/delete para `docs_research_sessions`, armazenando collections e final chunk IDs como JSON (`packages/docs-agent/src/session-store/docs-research-sessions-store.ts:62-159`). Isso torna pesquisas documentais recuperáveis e auditáveis, não apenas respostas efêmeras.

## Benchmarks de RAG documental

`scripts/docs-rag-eval.ts` avalia gold queries contra modos `fts`, `hybrid` e `rerank`, calculando success@5, recall@5, nDCG@10 e MRR (`scripts/docs-rag-eval.ts:82-103`). O script carrega DB vivo, monta a stack de doc search, imprime tabelas por modo e tipo de documento e suporta gate mínimo de recall (`scripts/docs-rag-eval.ts:127-203`).

## Telemetry routes e agregação

Rotas de telemetry expõem global admin telemetry, refresh/backfill de model prices e summaries/turn rows por sessão (`apps/http-api/server/routes/telemetry.ts:20-92`). A agregação global calcula totais de sessions/turns, cobertura de custo, top tools, phase breakdown e top sessions a partir das tabelas de coder telemetry (`packages/code-agent/src/sessions/store/telemetry-global.ts:84-310`).

A persistência de telemetry começou com `coder_turn_telemetry`, registrando session/run/turn, token counts, tool counts, compaction flags e lista serializada de tools (`packages/store/src/migrations/069_coder_turn_telemetry.ts:24-54`). Tool-call telemetry ganhou output sizing, truncation, phase e join key para turn telemetry; turn telemetry ganhou system-prompt/tools-def sizing e per-turn cost (`packages/store/src/migrations/072_telemetry_per_tool.ts:42-79`). Depois vieram request/response metadata, visible tools count, phase timings e `project_id` denormalizado (`packages/store/src/migrations/093_turn_request_response_meta.ts:22-53`, `packages/store/src/migrations/135_model_max_tools.ts:9-29`, `packages/store/src/migrations/138_run_phase_telemetry.ts:23-24`, `packages/store/src/migrations/162_telemetry_project_id.ts:2-44`).

## Snapshot store e review store

`SessionFileSnapshotStore` persiste baselines, edits, hunk decisions, fechamento de baseline e active-baseline lookup para sessões coder e company (`packages/store/src/session-file-snapshot-store.ts:87-258`). As migrations introduzem `session_file_baselines`, `session_file_edits` e `session_file_hunk_decisions`, com active baseline e hunk uniqueness (`packages/store/src/migrations/079_session_file_snapshots.ts:38-95`).

Snapshot review adiciona `session_file_review_runs` e `session_file_review_comments` vinculados a baselines (`packages/store/src/migrations/110_session_snapshot_reviews.ts:18-57`). `SessionFileReviewStore` persiste runs e comments com status, severity, diff excerpts e sent-state updates (`packages/store/src/session-file-review-store.ts:60-230`).

## Snapshot review pipeline

Rotas de snapshot review expõem runs/comments, criação/edição manual de comentários, execução de auto-review e fluxo de submit/delivery (`apps/http-api/server/routes/snapshot-review-routes.ts:171-340`). A pipeline resolve binding de reviewer, renderiza hunks pendentes, chama o reviewer, parseia findings e emite telemetry (`packages/services/src/services/snapshot-review-pipeline.ts:156-262`). Telemetry de snapshot review inclui provider/model diagnostics, duration bucket, candidate counts e IDs de sessão/company session (`packages/services/src/services/snapshot-review-pipeline.ts:239-257`).

A tool `self_review` do code-agent usa a mesma ideia como revisão barata das snapshots da sessão atual, distinta de `request_review`; falhas de config viram mensagens de disponibilidade acionáveis (`packages/code-agent/src/tools/self-review.ts:1-15`, `packages/code-agent/src/tools/self-review.ts:50-115`).

## Memory e snapshots

O projeto separa durable agent memory, snapshots e scratchpad de sessão. `remember` salva memories de projeto ou usuário e `recall_memory` retorna conteúdo com nota de staleness (`packages/code-agent/src/tools/project-memory-tools.ts:1-184`). `forget_memory` arquiva por título/nome em vez de hard-delete (`packages/code-agent/src/tools/project-memory-tools.ts:187-220`).

No store, snapshots evoluem para project memory por provenance/importance/access (`packages/store/src/migrations/114_snapshot_memory.ts:27-31`). User-scoped memory adiciona `scope` e cria projeto oculto `id = 0`, `name = '__user__'` (`packages/store/src/migrations/145_user_memory.ts:33-39`). Archive/soft delete usa `archived_at` e `archived_reason` (`packages/store/src/migrations/146_snapshot_archive.ts:29-34`).

## Design choices observados

- Pesquisa documental é tratada como run persistida, com tools próprias e fidelity gate.
- O sistema diferencia RAG simples (`rag_search_docs`) de deep research (`docs_deep_research`).
- Company docs podem virar corpus RAG real, com provenance sandbox/drive.
- Telemetry é granular por turno, tool, fase, custo e sessão.
- Snapshot review é um domínio próprio com baselines, edits, hunks, comments e delivery.
- Memória durável é explicitamente stale-prone e deve ser verificada contra código atual.
