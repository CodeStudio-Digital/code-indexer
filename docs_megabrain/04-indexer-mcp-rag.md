# Indexer, MCP, Search e RAG

## Visão geral

O projeto combina indexação estrutural, análise semântica, embeddings, busca híbrida, ferramentas MCP e RAG documental. Os componentes principais são:

- `packages/indexer`: pipeline de indexação, parsing, embeddings e hybrid search.
- `packages/store`: tabelas de files, symbols, dependencies, references, vectors e FTS.
- `apps/mcp-server`: ferramentas MCP de search, grep, symbol graph, project pulse, repo map e docs.
- `packages/docs-agent`: agente especializado em deep research sobre documentação.
- `packages/code-agent/src/tools/rag-search-docs.ts`: tools de busca/leitura de docs no agente.

## Pipeline principal do IndexAgent

`IndexAgent` roda o pipeline semântico principal: scan → analyze → embed → orphan sweep. O fluxo registra telemetry, budget checks, finalização de run, webhooks, emissão de `files_updated` e geração de snapshots (`packages/indexer/src/indexer/indexer.ts:96-359`).

Mudança de fingerprint do modelo de embeddings dispara `clearEmbeddingHashes()` e full re-embed sweep; o novo fingerprint só é salvo após o sweep bem-sucedido (`packages/indexer/src/indexer/indexer.ts:122-140`). O scanning usa `FileScanner(project.root_path, ignorePatterns, maxFileSize)` e ainda faz “dumb→smart catch-up” para reprocessar arquivos semânticos stale mesmo quando o scanner os marcou unchanged (`packages/indexer/src/indexer/indexer.ts:143-155`).

O trabalho de vector embeddings só roda quando `vectorStore.isAvailable()` e há embedding service; o batcher nasce antes da análise de arquivos e é flushado após o loop (`packages/indexer/src/indexer/indexer.ts:176-184`). Tree-sitter dispatch é criado por run e descartado em `finally`, com fallback para parsing in-process se worker path falhar (`packages/indexer/src/indexer/indexer.ts:185-259`). Orphan vector IDs são varridos no pós-run; falhas remotas são tombstoned e linhas locais de `vector_ids` são removidas de qualquer forma (`packages/indexer/src/indexer/indexer.ts:290-301`).

## Scanner e ignore rules

O scanner percorre glob, aplica ignore rules, yielda periodicamente para scheduling cooperativo, ignora arquivos grandes e classifica em `toIndex`, `unchanged` e `toRemove` (`packages/indexer/src/indexer/scanner.ts:62-183`). Detecção de unchanged é stat-first (`mtime_ms` + size) e depois hash-based; em hash mismatch com conteúdo igual, atualiza mtime (`packages/indexer/src/indexer/scanner.ts:132-155`).

Promoção de tier baseada em graph usa in-degree da execução anterior, e file records carregam mapper reason/tier metadata (`packages/indexer/src/indexer/scanner.ts:157-177`). Ignore defaults incluem build/output dirs e lockfiles; glob pruning pula hard-safe dirs no walk (`packages/indexer/src/indexer/scanner-ignore.ts:22-54`). Rules combinam defaults, padrões do caller, `.gitignore`, `.mcpindexignore`, extensões binárias e hard-exclusion hook (`packages/indexer/src/indexer/scanner-ignore.ts:67-98`).

A documentação de indexer descreve `.mcp-indexer.json`, `.mcpindexignore` e prioridade de regras de ignore (`docs/INDEXER.md:185-248`).

## Tree-sitter e extração estrutural

Tree-sitter usa worker pool por padrão, com fallback sticky por processo para parsing in-process se o pool estiver indisponível (`packages/indexer/src/indexer/tree-sitter-dispatch.ts:1-83`). Arquivos suportados são parseados com tree-sitter; symbols, namespace, imports/references e call references são extraídos no payload de análise, com `tree.delete()` em `finally` (`packages/indexer/src/indexer/tree-sitter/extractor.ts:205-257`).

A extração de símbolos percorre AST, ignora inline arrow callbacks, monta metadata de symbol e captura parent, modifiers, signature, parameters, return type, inheritance/implements, comments, tags e PHP trait uses (`packages/indexer/src/indexer/tree-sitter/extractor.ts:282-377`). Heurísticas de exported visibility são language-specific e caem para file-top-level quando a linguagem não tem semântica explícita de export (`packages/indexer/src/indexer/tree-sitter/extractor.ts:384-418`). Nomes de símbolos são derivados de shapes de AST por linguagem, incluindo CSS selectors/at-rules e HTML/Vue structural/custom elements (`packages/indexer/src/indexer/tree-sitter/extractor.ts:422-493`). Modifiers como export/static/public são coletados de estrutura e texto bruto (`packages/indexer/src/indexer/tree-sitter/extractor.ts:495-532`).

## Processamento por arquivo

O processamento por arquivo lê conteúdo lazy e é tree-sitter-first. Arquivos suportados podem pular LLM quando a estrutura está unchanged; caso contrário, o sistema escolhe entre summary ou full analysis (`packages/indexer/src/indexer/indexer/process-file.ts:58-179`). File, symbols, dependencies, references, semantic hash, file content e snapshot são commitados em uma transação (`packages/indexer/src/indexer/indexer/process-file.ts:117-165`). Structure hash e structure embedding são persistidos quando disponíveis; references ganham line/col antes do storage (`packages/indexer/src/indexer/indexer/process-file.ts:140-159`).

Estrutura unchanged ou near-unchanged é comparada via MD5 structure hash e opcionalmente embeddings; se similaridade for alta, metadata LLM existente é reutilizada, senão usa caminho summary ou full analysis (`packages/indexer/src/indexer/indexer/process-file.ts:181-264`).

## Symbol graph, stable IDs e relações

`stable_id` foi adicionado a `symbols` para identidade determinística entre reindexações, derivado de `projectId:filePath:kind:parent:name:signature` (`packages/store/src/migrations/002_symbol_stable_id.ts:2-15`). O ID é SHA-1 do material concatenado (`packages/store/src/migrations/002_symbol_stable_id.ts:39-51`).

O upsert de symbols apaga símbolos/relações antigos do arquivo e insere novos com `stable_id` computado, além de relations `extends`, `implements` e PHP `mixes` (`packages/store/src/db/symbols.ts:14-67`). Existem helpers para stable ID, nome, arquivo, class members, prefix search, FTS search e listing por kind (`packages/store/src/db/symbols.ts:79-123`).

`symbol_references` guarda referências; a resolução de symbol name no insert usa lookup name-only em `symbols` (`packages/store/src/db/symbol-relations.ts:13-41`). Queries alimentam `getCallers`, `getHierarchy`, `getImplementors` e `getSubclasses` (`packages/store/src/db/symbol-relations.ts:48-97`). Usage tracing segue recursivamente `symbol_references` por nome, com proteção de ciclo e profundidade limitada (`packages/store/src/db/symbol-relations.ts:112-163`).

File in-degree é derivado de `file_dependencies` e dirige promoção auto-mapper (`packages/store/src/db/maintenance.ts:52-67`).

## Vector store e embeddings

O barrel público do indexer exporta `IndexAgent`, `HybridSearch`, reranker helpers, `RecentFilesSource`, invalidation cache, `EmbeddingService`, `NullEmbeddingService`, `createEmbeddingService`, model discovery e search-bundle bootstrap (`packages/indexer/src/index.ts:8-52`).

O search bundle compõe embeddings + vector store + `HybridSearch`; pode usar vector store scoped por projeto quando vectors per-project estão habilitados, e injeta HYDE, reranker, recent files e telemetry (`packages/indexer/src/bootstrap/search-bundle.ts:29-83`).

O contrato `EmbeddingService` inclui embedding de query/text, fingerprint estável para detecção de reindex, hints de concorrência e dispose opcional (`packages/indexer/src/search/embeddings.ts:5-27`). O backend Cloudflare inclui retry/timeout, batch sizing/token estimation, split recursivo em context overflow, fingerprint `cloudflare:bge-m3` e `maxConcurrency()` 4 (`packages/indexer/src/search/embeddings.ts:29-221`). O backend Bedrock Titan tem SDK dinâmico, timeout e suporte a IDs Titan v1/v2 (`packages/indexer/src/search/embeddings.ts:248-562`). Cache local de modelos ONNX prefere config explícita, depois `MCP_MODEL_CACHE_DIR`, depois `~/.mcp/models`, criando diretório best-effort (`packages/indexer/src/search/model-cache.ts:1-27`).

`vector_ids` usa `INSERT OR REPLACE`, tornando registro idempotente em reindex (`packages/store/src/db/vectors.ts:12-28`). A tabela suporta listing por projeto, orphan detection e stats por type (`packages/store/src/db/vectors.ts:30-76`). Deletes são chunked, deduped e podem entrar em pending deletes se remoto falhar (`packages/store/src/db/vectors.ts:81-158`). Project splitting pode migrar INDEX tables para DB por projeto e disparar split de vectors separadamente (`packages/store/src/db.ts:314-346`).

## Hybrid search

`HybridSearch` tem cache LRU de query, modo `auto`, paths distintos `fts`, `vector` e `hybrid`, pipeline V2 opcional por `MCP_PIPELINES_INDEXER_SEARCH_V2`, recent-files/content streams, graph expansion e reranking (`packages/indexer/src/search/hybrid.ts:114-370`).

A documentação descreve a plataforma como indexação LLM com hybrid search, MCP server, dashboard, memory, dependency graph, call graph, symbol hierarchy e docs export (`docs/INDEXER.md:1-4`). Também documenta provider support para ZAI, Anthropic, OpenAI, OpenRouter, DeepSeek e Gemini (`docs/INDEXER.md:250-259`).

## MCP tools de search e symbols

O MCP `search` usa `HybridSearch.searchWithDiag`; expõe `search` e `grep_code`. `grep_code` faz filtering de arquivos indexados, prefilter de content index e fallback para disco quando índice está vazio ou falha, além de diagnostics em no-results (`apps/mcp-server/tools/search.ts:23-215`).

Disk fallback de símbolos usa tree-sitter + regex para localizar símbolo, extrair corpo e listar símbolos por arquivo sem depender do DB (`apps/mcp-server/tools/symbols.ts:22-50`). `find_references` usa caller data do DB primeiro e cai para grep; JSON output inclui candidates quando ambíguo e tags de source DB/grep/disk fallback (`apps/mcp-server/tools/symbols.ts:78-166`).

`get_hierarchy` reporta extends chain, implemented interfaces, traits, subclasses e implementors via graph data (`apps/mcp-server/tools/symbols.ts:169-232`). `trace_usage` percorre caller tree do DB ou fallback grep depth-1 com warning explícito (`apps/mcp-server/tools/symbols.ts:234-322`). `get_symbol_body` resolve por DB ou file scan fallback, suporta JSON e orienta search/skeleton/read_file quando não resolve (`apps/mcp-server/tools/symbols.ts:325-413`).

`prepare_edit` junta body, callers, neighbors, imports e tests; quando symbol DB está ausente, degrada para fallback de disco sem imports/tests e com tree-sitter/grep (`apps/mcp-server/tools/symbols.ts:416-631`). `semantic_neighbors` faz vector search sobre symbol-body embeddings primeiro e depois symbol-level; recusa se vector search indisponível (`apps/mcp-server/tools/symbols.ts:635-705`). A surface exportada inclui `find_references`, `get_hierarchy`, `find_implementations`, `trace_usage`, `get_symbol_body`, `prepare_edit` e `semantic_neighbors` (`apps/mcp-server/tools/symbols.ts:708-716`).

## Project overview tools

`index_project` invoca `IndexAgent`, aceita provider/model e `force`, retornando counts/cost/duration (`apps/mcp-server/tools/projects.ts:9-34`). `get_project_overview` expõe stats, architecture layers, concepts e file lists; compact mode corta por token budget e max file count (`apps/mcp-server/tools/projects.ts:37-89`). `get_project_pulse` é resumo ultra-compacto com counts de files/symbols/lines, last indexed, top concepts, entry points, snapshot count, vector coverage e cost summary (`apps/mcp-server/tools/projects.ts:91-169`). `get_repo_map` delega a `buildRepoMap` com token budget e dependency graph (`apps/mcp-server/tools/projects.ts:175-189`).

Auditoria de tools lista `get_project_pulse`, `grep_code`, `read_file`, `search`, `find_references`, `get_project_overview`, `get_repo_map`, `get_symbol_body`, `search_memory` e `rag_search_docs` entre tools rastreadas (`docs/audit/tools-mcp-server.md:14-40`).

## LSP e fallback estrutural

A doc do indexer descreve LSP in-process para definition/references/hover/diagnostics e fallback para Python/Go/Rust diagnostics (`docs/INDEXER.md:29-38`). O fallback de document symbols reconstrói hierarquia a partir de `symbols.parent` (`packages/api-handlers/src/lsp/fallback-document-symbols.ts:1-45`). Ranking de fallback usa proximidade de arquivo: arquivo atual, imports diretos, mesmo diretório e restante (`packages/api-handlers/src/lsp/index-fallback.ts:67-88`). Definition, references, hover e completion fallback usam `symbols`, `symbol_references` e `file_dependencies` em vez de language server (`packages/api-handlers/src/lsp/index-fallback.ts:90-194`).

O LSP router mantém state via document store: TS/JS vão ao TS service in-process, outras linguagens a LSPs externos e fallback estrutural cobre o resto (`packages/api-handlers/src/lsp/index.ts:4-17`). TS diagnostics são debounced e publicados via diagnostics hub; non-TS syntax diagnostics também são debounced quando nenhum server está pronto (`packages/api-handlers/src/lsp/index.ts:123-177`). Completions mesclam server results com index results, preservando prioridade do server (`packages/api-handlers/src/lsp/index.ts:228-279`). Syntax diagnostics non-TS vêm de tree-sitter, limitados a 50 findings (`packages/api-handlers/src/lsp/syntax-diagnostics.ts:39-76`).

## Docs RAG e DocsAgent

`rag_search_docs` no MCP é read-only e consulta o singleton global de doc-search, retornando metadata de source/heading/snippet; se singleton não está wireado, retorna erro claro (`apps/mcp-server/tools/docs.ts:1-95`). No code-agent, `rag_search_docs` usa backend global configurado por `setGlobalDocSearch()` (`packages/code-agent/src/tools/rag-search-docs.ts:46-52`). A tool suporta scope por projeto ou corpus inteiro, diferencia no-good-match/no-results explicitamente e retorna chunk IDs para leitura subsequente (`packages/code-agent/src/tools/rag-search-docs.ts:54-184`).

`DocsAgent` é um orquestrador multi-step sobre corpus documental (`packages/docs-agent/src/index.ts:1-20`). `runDocsAgent` cria sessão, resolve binding `docs_research/scorer_llm`, monta toolset/sistema docs, executa `CoderRunner`, aplica fidelity review gate e persiste telemetry/sucesso/falha (`packages/docs-agent/src/index.ts:79-273`). O review gate hidrata cited chunks, verifica claims com modelo forte, inclui reviewer usage em telemetry e finaliza falhas com markdown placeholder e low confidence (`packages/docs-agent/src/index.ts:288-381`).

Toolset do DocsAgent inclui plan, list sources, search, read chunk, synthesize e finish (`packages/docs-agent/src/index.ts:137-152`). `docs_finish` valida markdown/chunk IDs/confidence, salva payload final e aborta runner (`packages/docs-agent/src/tools/docs-finish.ts:38-117`). O bridge `docs_deep_research` valida input, faz fallback para `rag_search_docs` se bridge ausente, roda subagent e retorna markdown + chunks citados (`packages/docs-agent/src/bridges/docs-bridge.ts:96-180`).

Company docs-to-RAG permite ingerir doc de company session na pipeline real, linkar collection ao projeto e chamar `runIngest(..., { skipGate: true })` (`apps/http-api/server/routes/company/docs-rag.ts:84-147`). Status de RAG verifica `doc_sources` com status `done` (`apps/http-api/server/routes/company/docs-rag.ts:149-167`).

## Benchmarks/evals

`scripts/docs-rag-eval.ts` avalia queries gold contra modos `fts`, `hybrid` ou `rerank`, calculando success@5, recall@5, nDCG@10 e MRR (`scripts/docs-rag-eval.ts:82-103`). O script carrega DB vivo, monta doc search stack, imprime tabelas por modo/tipo de doc e suporta recall gate (`scripts/docs-rag-eval.ts:127-203`).

## Design choices

- Indexer combina estrutura, texto, embeddings e graph; não depende só de vector search.
- Fallbacks são explícitos: disk fallback para symbols, grep fallback para references, structural fallback para LSP.
- Embedding fingerprint controla re-embed e evita hashes obsoletos.
- Search e docs RAG compartilham padrões: singleton global, chunk IDs, diagnostics claros e eval scripts.
- MCP server é a surface que expõe as capacidades do indexer para agentes e clientes externos.
