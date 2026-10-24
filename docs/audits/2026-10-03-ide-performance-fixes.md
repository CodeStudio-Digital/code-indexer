# Correções de desempenho da IDE — 03/10/2026

## Resultado

Implementadas correções na fila semântica, consultas SQLite, indexação estrutural, RAG e busca de arquivos em React. A limpeza da fila foi aplicada ao banco local; as demais mudanças estão no código e nos builds de `D:\MCP`. O aplicativo instalado não foi substituído nem reiniciado nesta execução.

## Fila local: limpeza aplicada

O banco `C:\Users\maico\.mcp-code-indexer\index.db` continha 48.702 trabalhos pausados. Foram removidas **47.946 tentativas antigas duplicadas de build** de memória/snapshots, mantendo a tentativa mais recente por namespace/geração/tipo. Permaneceram 756 pausados, 480 pendentes, 2.618 concluídos e 1.158 cancelados.

- Backup SQLite consistente: `D:\MCP\.tmp\semantic-queue-cleanup-20261003-1425\index-before-cleanup.db`.
- Relatório: `D:\MCP\.tmp\semantic-queue-cleanup-20261003-1425\cleanup-result.json`.
- `quick_check`: `ok`; digest dos trabalhos preservados e dos ponteiros de geração verificado dentro da transação.
- Não foram apagados deltas/fences, gerações, conteúdo indexado ou trabalhos pendentes.
- Ferramenta reproduzível: `scripts/cleanup-semantic-queue.mjs`. Sem `--apply`, apenas informa candidatos. A aplicação exige diretório novo de backup e ausência de trabalhos em execução.

## Mudanças

### Fila e SQLite

- Builds de docs, memória e snapshots reutilizam a tentativa pendente/pausada da mesma geração, em vez de criar uma linha por falha.
- Retentativas automáticas de memória persistem tentativa, prazo e suspensão no cursor. Rate limits têm espera maior; falhas de runtime/credenciais suspendem imediatamente; oito falhas não relacionadas a contenção SQLite suspendem a repetição automática. O reindex manual permite recuperação.
- Uma nova mutação não apaga a espera existente. A geração ativa continua protegida pelas verificações de cobertura e fences.
- Consultas de deltas filtram status e tipo no SQL. Verificações de fence usam `SELECT 1 ... LIMIT 1`; contagens usam `GROUP BY`, sem hidratar o histórico completo.
- Migração 268 adiciona índice por namespace/tipo/status/id. Ela será aplicada quando o backend atualizado abrir o banco normalmente.

### Indexação estrutural

- Falhas de operações já enviadas ao worker são propagadas; não iniciam uma segunda cópia pesada no processo principal do Electron. Timeout encerra o worker antes de permitir nova tentativa.
- O desktop informa erro se o worker estiver indisponível. O fallback de descoberta permanece disponível para CLI independente.
- Projetos acima do orçamento do watcher recebem reconciliação estrutural periódica no worker, incluindo arquivos fechados, criações e exclusões externas. Há no máximo uma reconciliação de fallback sendo agendada por vez; trabalho interativo tem prioridade.
- As verificações de arquivos abertos usam `stat` assíncrono e tratam exclusão/recriação. O estado distingue monitoramento ao vivo, verificação periódica e desligado.
- O limite padrão de candidatos da indexação automática passa de 20.000 para 100.000; configurações explícitas existentes continuam sendo respeitadas. `MCP_WATCH_FALLBACK_RECONCILE_MS` controla o intervalo, padrão de 60 segundos.

### RAG

- Embeddings locais de backfill cedem a fila a cada 16 textos. Consultas interativas têm prioridade no próximo lote.
- A fila de inferência aceita no máximo 128 solicitações em espera. Abortos são enviados ao worker e removem inferência pendente; uma execução nativa já iniciada termina seu lote.
- Consultas idênticas no mesmo espaço de embedding compartilham codificação entre coleções. Cache limitado a 128 vetores e 30 segundos; geração ativa, dimensão, identidade do backend e perfil desativado continuam sendo verificados antes de servir.
- Hidratação para reranking lê fontes de forma assíncrona, com quatro leituras simultâneas, limite de 2 MiB por arquivo e 8 MiB por consulta. Símbolos tardios dentro do limite preservam seu corpo; fontes maiores continuam representadas pelos fatos estruturais.
- Reranking de documentação recebe conteúdo do chunk, limitado a 8.000 caracteres, em vez de somente o preview de 480 caracteres.
- A busca semântica interativa pede 20 resultados, compatível com o menor orçamento de reranking local.
- Os modelos/provedores escolhidos pelo usuário não foram alterados. O perfil salvo pode continuar usando inferência remota; o teste offline abaixo valida separadamente o caminho local E5 + SQLite.

### React / busca de arquivos

- Novo contrato `files.searchPaths`, disponível em IPC e em `GET /api/projects/:id/file-paths`, retorna somente caminhos e no máximo 300 resultados.
- Busca por substring/subsequência e classificação ocorrem no SQL, com isolamento de projeto e parâmetros escapados.
- Search Everywhere e filtro da árvore deixaram de baixar `DBFile[]` completo e varrer/ordenar todo o projeto em cada tecla. Usam debounce, cancelamento e resultado limitado.
- A árvore mantém virtualização e informa ausência de resultados apenas após o término da consulta.

## Evidência de desempenho

Comparação no **mesmo backup anterior à limpeza**, somente leitura, sem o índice novo, namespace `memory:project:p10`. Duas execuções de aquecimento e 15 amostras por consulta; inclui leitura e `JSON.parse` dos cursores retornados.

| Consulta | Linhas retornadas | Mediana | p95 |
|---|---:|---:|---:|
| Histórico completo anterior | 15.494 | 344,903 ms | 483,732 ms |
| Deltas/backfills abertos filtrados | 66 | 68,418 ms | 73,346 ms |
| Existência de fence em execução | 0 | 0,004 ms | 0,004 ms |

A mediana da consulta filtrada foi aproximadamente **5 vezes menor**, antes mesmo da limpeza e da migração. Isto mede SQL/hidratação, não latência completa da IDE nem FPS. Resultado bruto: `.tmp/ide-perf-query-benchmark.json`.

## Validação

- **226 testes direcionados passaram**, em 18 arquivos: fila/coordenador, SQLite, busca de caminhos, worker estrutural real com parser pool, prioridade/cancelamento, cache por geração, hidratação, docs, lifecycle do watcher e stores da interface.
- **RAG offline real passou**: modelo E5 quantizado já em cache → embeddings → SQLite vec → consulta → documento semanticamente correto em primeiro lugar. Downloads remotos desabilitados; nenhuma configuração de modelo do usuário foi modificada.
- **3 cenários Chromium passaram**, em 1280×720, 1440×900 e 1920×1080. Componentes React reais com respostas HTTP de teste; comprovam descarte de resposta antiga, seleção correta, nenhuma chamada à listagem completa e DOM limitado. A execução de inspeção renderizou 31 linhas para 300 resultados, sem erros JavaScript.
- Builds de backend (`tsc`, `tsc-alias`, cópia de prompts) e dashboard (`vite build apps/dashboard`) passaram. Checagem de tipos de produção e `git diff --check` dos arquivos desta correção passaram.
- O comando pnpm disponível tentou sincronizar dependências antes do build e abortou por falta de TTY. Os mesmos executáveis já instalados foram chamados diretamente; dependências nativas não foram reconstruídas.

Regressão de navegador reproduzível: iniciar Vite e executar `ide-search-performance.spec.ts` com a configuração Playwright do dashboard. A fixture não precisa de backend nem de dados reais.

## Limites da verificação

Não foi realizado perfil de uma sessão completa do aplicativo instalado após distribuição. Os chunks grandes já presentes de Monaco e outras dependências continuam aparecendo no aviso do Vite. A validação offline utilizou uma consulta de fumaça, não um benchmark amplo de relevância de todos os projetos. Limites de provedores externos e configurações explícitas precisam continuar visíveis como erros/estado degradado; não são eliminados por otimizações locais.
