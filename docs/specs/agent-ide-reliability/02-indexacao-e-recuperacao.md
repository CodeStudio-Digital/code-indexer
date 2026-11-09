# 02 — Indexação e recuperação para agente e IDE

**Estado:** proposta; nenhuma mudança de runtime implementada nesta revisão.

**Baseline:** `448d526dd2e24247617938721c0d8cf18ce850cf`, CodeStudio 3.15.1, 25/10/2026.

**Escopo:** índice estrutural, conteúdo, semântica, caminhos, recuperação de contexto e consumidores IDE/agente/MCP/CLI.

## 1. Resultado esperado e limites da análise

Salvar, criar, renomear ou excluir um arquivo deve produzir evidência pesquisável da revisão correta. Falha, atraso de atualização, corte de resultado e cobertura incompleta devem ser observáveis. A indexação só entrega valor quando reduz o tempo e as chamadas necessários para localizar evidência correta sem prejudicar a edição.

Esta proposta deriva de leitura de código e testes existentes. Não foram executados reindexação, inferência, consultas a bancos reais ou benchmarks deste subsistema. Os custos descritos como hipóteses precisam de medição; as metas e os gates comuns estão em [07](./07-implementacao-e-validacao.md).

Aplicam-se os contratos CTR-01 a CTR-07 de [06](./06-contratos-e-observabilidade.md). Os tipos deste documento especializam esses contratos; não criam outro envelope de execução nem alteram unilateralmente o protocolo MCP.

## 2. Infraestrutura atual a preservar

| Capacidade existente | Evidência no baseline | Implicação |
|---|---|---|
| Scan stat-first/hash e indexação estrutural sem LLM | `packages/indexer/src/indexer/structural.ts:4` | Manter baseline barato e independente da semântica. |
| Preparação/parser separados de escrita em lotes | `packages/indexer/src/indexer/structural-incremental.ts:109` | Evoluir confirmação e budgets sobre o pipeline atual. |
| Cache de extração versionado por conteúdo, extensão e extractor | `packages/indexer/src/indexer/extract-cache.ts:78` | Não propor parser/cache novos sem ganho medido. |
| Worker estrutural sem fallback silencioso para o main no Electron | `apps/http-api/sse/IndexerWorkerClient.ts:246` | Preservar isolamento e erro explícito de bundle ausente. |
| Evicção do worker após timeout antes de retry | `apps/http-api/sse/IndexerWorkerClient.ts:145` | Preservar proteção contra dois escritores concorrentes. |
| Watcher antes do scan, barreira ready e drain antes do baseline | `packages/services/src/services/project-index/service.ts:237` | Testar essas invariantes durante a migração. |
| Coalescência de checkout e reconciliação por lifecycle | `packages/services/src/services/project-index/service.ts:125` | Não voltar a scan integral por mensagem do agente. |
| Polling de arquivos abertos e reconciliação de árvores grandes | `packages/services/src/services/project-index/service-state.ts:104` | Melhorar frescor mensurado, sem eliminar fallback. |
| FTS, conteúdo, vetor, recentes, grafo, RRF e reranker | `packages/indexer/src/search/hybrid-pipeline.ts:1` | Medir contribuição de cada estágio antes de expandi-lo. |
| Planner lexical/híbrido com regras PT/EN | `packages/indexer/src/search/planner.ts:30` | Consolidar política e avaliar por classe de consulta. |
| Cache por geração semântica/alvo de reranker | `packages/indexer/src/search/hybrid.ts:429` | Acrescentar revisão estrutural; TTL não garante frescor. |
| Debounce, abort e virtualização na árvore | `apps/dashboard/features/workspace/file-tree/FileTreeView.tsx:155` | Validar backend e aplicação real além do DOM. |
| Estágios lexical e semântico separados na IDE | `apps/dashboard/features/search-everywhere/SearchEverywhere.tsx:221` | Preservar primeira resposta rápida e supersession. |

## 3. Diagnóstico verificável

### 3.1 Confirmação insuficiente dos deltas

`DirtyQueue.takeBatch` remove caminhos antes da execução (`packages/services/src/services/project-index/dirty-queue.ts:30`). `drainDirtyLocked` não recoloca o lote quando o RPC falha e ignora o resultado de `indexFiles` (`service.ts:412`). O contrato já contém `errors` (`project-index/types.ts:100`); o executor conta falhas de arquivo e commit (`structural-incremental.ts:104`, `:202`).

`scheduleDrain` registra a exceção e só reprograma itens ainda presentes (`service.ts:456`). Logo, uma falha transiente pode retirar definitivamente aquele evento da fila, deixando o índice antigo até uma reconciliação posterior. Isso é um caminho de falha identificado no código, não uma ocorrência medida na instalação do usuário.

### 3.2 Cache sem revisão estrutural

O TTL atual é cinco minutos (`hybrid.ts:184`). A chave inclui geração semântica e reranker, mas não revisão dos arquivos, símbolos ou conteúdo (`hybrid.ts:429`). Em FTS, a revisão semântica é `not-used`. O único chamador externo de invalidação encontrado na inspeção é o purge de arquivos ignorados (`apps/http-api/server/routes/project-detail-routes.ts:155`).

Assim, salvar e repetir a mesma consulta pode servir a entrada anterior após o commit estrutural. A magnitude depende do consumidor, modo e cache aquecido; não foi medida nesta revisão.

### 3.3 Completude e trabalho físico de grep

`grep_code` carrega os arquivos indexados (`apps/mcp-server/tools/search.ts:275`) e só busca no disco quando encontra zero hits (`:341`). Um arquivo novo pode ser omitido se outro arquivo indexado já tiver correspondência, mesmo com espaço no limite de resultados.

O fallback enumera todos os matches antes de aplicar `slice` (`search.ts:76`); o caminho sintético enumera cada raiz (`:47`). `grepInFiles` lê e divide arquivos inteiros de forma síncrona, sem sinal ou orçamento de bytes (`packages/services/src/services/code-reader.ts:113`). `max_results` tem mínimo, mas não teto físico nesse handler (`search.ts:269`). O impacto de CPU, memória e I/O é hipótese a perfilar.

### 3.4 Limites de caminhos, cancelamento e IDE

`searchPaths` limita a resposta a 300, mas usa `LIKE '%...%'` e ordenação calculada (`packages/store/src/db/files.ts:6`). Isso não limita o universo avaliado; o custo depende do corpus e plano SQL.

Em `searchGlobal`, o ramo FTS/vector descarta sinal e contexto ao chamar `search`, e o loop não testa cancelamento antes do próximo projeto (`hybrid.ts:308`). O ramo vetorial direto não recebe options em `vectorSearchExpanded` (`:612`); o RPC vetorial também não recebe signal nessa fachada (`apps/http-api/sse/SemanticVectorWorkerClient.ts:238`).

Search Everywhere aguarda caminhos antes de solicitar símbolos (`SearchEverywhere.tsx:157`). O MCP usa `auto` por default (`apps/mcp-server/tools/search.ts:158`), enquanto o handler API pode cair em `hybrid` (`packages/api-handlers/src/search/index.ts:41`). A fase `semantic_ready` é derivada de stamps/contadores com stale separado (`project-index/status-store.ts:157`); auditar os consumidores antes de concluir que toda apresentação dessa fase está incorreta.

## 4. Requisitos obrigatórios

| ID | Prioridade | Requisito e critério de aceite |
|---|---|---|
| IDX-01 | P0 | Confirmar delta por caminho e sequência somente após commit; falha de RPC/arquivo/commit não perde trabalho. |
| IDX-02 | P0 | Persistir pendências coalescidas e recuperar leases interrompidos; novo evento durante processamento nunca é apagado pelo ack antigo. |
| IDX-03 | P0 | Publicar revisão estrutural no commit e usá-la no cache; repetir busca após commit não retorna entrada de revisão anterior. |
| IDX-04 | P1 | Expor cobertura, frescor, falhas e motivos de exclusão separadamente da disponibilidade; zero hits parcial nunca prova ausência. |
| IDX-05 | P1 | Busca exata em workspace inclui deltas/arquivos novos ou declara cobertura parcial; o caso com hit antigo e hit novo tem regressão. |
| IDX-06 | P1 | Limitar aquisição por arquivos, bytes, candidatos e deadline; cap de saída não substitui cap de trabalho. |
| IDX-07 | P1 | Propagar cancelamento/supersession até o owner físico em todos os modos e consumidores; não admitir nova etapa após cancelamento. |
| IDX-08 | P1 | Preservar escopo de projeto/raiz/permissão, ignore e identidade de arquivo em índice, disco, cache e workspace composto. |
| IDX-09 | P1 | Entregar evidência estruturada com versão, origem, caminho e localização; leitura posterior revalida a revisão se necessário. |
| IDX-10 | P1 | Avaliar qualidade por tarefa, idioma e classe de query; semântica precisa demonstrar ganho sobre baseline lexical. |
| IDX-11 | P2 | Compartilhar política de busca IDE/agente, paralelizar leituras independentes dentro do budget e apresentar falha distinta de vazio. |
| IDX-12 | P1 | Validar carga, recuperação e upgrade na build empacotada/instalada antes de declarar a correção entregue ao produto. |

## 5. Arquitetura incremental proposta

### 5.1 Journal, leases e confirmação

Evoluir `ProjectIndexService` e a fila atual para um journal local por projeto, com chave canônica de caminho e sequência de evento. Persistir lote coalescido antes de reconhecer sua admissão; não escrever uma linha nova por tecla. A origem é watcher, save, operação do agente ou reconciliação. O journal não contém conteúdo integral dos arquivos.

Fluxo: admitir/coalescer -> adquirir lease -> capturar revisão e fence -> preparar -> commit -> registrar resultado -> ack. Cada lease possui owner, prazo e attempt. O ack elimina somente a sequência processada. Um evento posterior permanece pendente mesmo quando tem o mesmo caminho.

O executor retorna status individual: `indexed`, `unchanged`, `removed`, `ignored`, `retryable_error` ou `permanent_error`. Erros parciais não avançam o watermark desses caminhos. Retentativas têm limite/backoff/deadline; erro permanente vai para cobertura e ação de recuperação, sem loop infinito.

Crash depois do commit e antes do ack gera resultado desconhecido. Reconciliar hash/revisão e ownership antes de reexecutar. Preservar a evicção do worker antigo em timeout; nunca iniciar uma segunda mutação enquanto o primeiro ainda puder escrever. A idempotência estrutural é um contrato explícito deste executor, não permissão genérica para repetir efeitos externos.

### 5.2 Revisões e publicação

Manter `projectGeneration` para identidade da raiz/configuração do índice, `structuralRevision` para mudanças relacionais confirmadas e `semanticGeneration`/`semanticRevision` para vetores. Alterar ignore ou extractor agenda reconciliação e altera a revisão apropriada; renomear apenas o display name não troca identidade.

Commit estrutural que altera paths/símbolos/conteúdo/dependências incrementa revisão na mesma transação. Passagem sem mudanças não a incrementa. Publicação entre workers deve permitir leitura consistente da revisão e resultados; não basta invalidar um Map em apenas um processo.

Cache inclui revisão, filtros, formato, política de ranking e escopo de acesso. TTL é proteção adicional. Se não for possível obter revisão confiável, bypass. Coalescer somente leituras equivalentes na mesma revisão, com cancelamento por waiter conforme CTR-02/CTR-04.

### 5.3 Recuperação por intenção e orçamento

Identificador/path/literal usa caminho lexical barato. Conceito usa pipeline híbrido existente. A precedência é override explícito -> política do projeto -> `auto`; preservar escolha deliberada do usuário. Não introduzir chamada LLM para classificar cada tecla.

Path search deve testar candidatos por basename/prefixo/token/camelCase antes de fuzzy amplo. Escolher FTS, trigrama ou estrutura dedicada após `EXPLAIN QUERY PLAN` e comparação de recall/latência. Queries curtas e subsequência recebem orçamento próprio, sem carregar todos os `DBFile` no renderer ou no handler.

FTS de conteúdo pode ordenar candidatos, mas não provar impossibilidade de substring/regex. O conjunto final de grep vem de índice atualizado mais delta/overlay ou de busca física em worker/processo com limites. Enumerar disco incrementalmente; centralizar ignore, arquivos binários, tamanho máximo e política de junctions.

Regex síncrona não é interrompida por apenas verificar `AbortSignal`. Usar backend interrompível ou isolamento cujo owner possa encerrar o trabalho. Quando `rg` for escolhido, disponibilidade e comportamento no bundle são testados; o serviço de execução segue [04](./04-execucao.md), sem shell montado por concatenação.

### 5.4 Prioridade e lifecycle

Manter uma reconciliação por lifecycle, dirty batching, barreira watcher e modo polling explícito. Scheduler reserva capacidade para edição e busca, limita backfill e aplica aging. Reportar watcher `live|polling|off` junto da idade observada; nenhuma modalidade promete frescor instantâneo.

CPU de parser, regex, enumeração pesada e inferência permanece fora do main. Instrumentar CPU/I/O/RSS agregado, não somente heap JavaScript. Saturação devolve motivo e recuperação; filas não crescem ilimitadamente. O primeiro índice parcial pode servir evidência útil sem ser anunciado como cobertura integral.

## 6. Contrato de busca proposto

Os tipos abaixo são contratos internos v2 a integrar aos donos existentes. `InvocationContextV2`, `ResourceVersion` e `ResultEvidenceV2` são os de [06](./06-contratos-e-observabilidade.md); não duplicar suas definições em packages diferentes.

```ts
interface SearchRequestV2 {
  version: 2;
  context: InvocationContextV2;
  query: string;
  intent: 'path' | 'symbol' | 'literal' | 'regex' | 'concept' | 'auto';
  mode?: 'auto' | 'fts' | 'vector' | 'hybrid';
  scope: 'indexed' | 'workspace';
  freshness: 'best_effort' | 'required';
  minimumVersion?: ResourceVersion;
  filters?: { paths?: string[]; languages?: string[]; kinds?: string[] };
  budget: { maxResults: number; maxBytes: number; maxFiles: number; maxCandidates: number };
  supersessionKey?: string;
  cursor?: string;
}

interface SearchResponseV2 {
  version: 2;
  evidence: ResultEvidenceV2;
  coverage: {
    scope: 'indexed' | 'workspace';
    freshness: 'current' | 'stale' | 'unknown';
    pendingChanges: number;
    eligibleFiles?: number;
    coveredFiles: number;
    failedFiles: number;
    excludedByReason: Record<string, number>;
    reasons: string[];
  };
  hits: Array<{
    id: string;
    projectId: number;
    path: string;
    kind: 'file' | 'symbol' | 'line';
    location?: { startLine: number; endLine: number; column?: number };
    source: Array<'path' | 'fts' | 'content' | 'vector' | 'graph' | 'disk' | 'overlay'>;
    contentHash?: string;
    excerpt?: string;
  }>;
  nextCursor?: string;
}
```

`freshness:'required'` aguarda a revisão mínima/dirty fence até o deadline ou retorna falha tipada com evidência parcial; não reindexa todo o projeto implicitamente. `current` exige evidência do watermark observado, não apenas timestamp recente. Alteração externa ainda não observada é uma limitação declarada da cobertura, principalmente no polling.

`completeness` vem do envelope comum. Cursor é vinculado à revisão e ao escopo; revisão incompatível expira o cursor ou mantém snapshot real, nunca mistura páginas silenciosamente. Ordenação é estável. Scores específicos de fontes não são apresentados como probabilidades comparáveis.

MCP projeta os dados em `structuredContent` quando suportado e preserva texto compatível; `code_exec` recebe a representação estruturada conforme [03](./03-descoberta-e-mcp.md). UI usa a mesma semântica com rendering próprio. Arquivo modificado entre busca e leitura exige revalidação de hash/revisão antes de usar offsets como prova.

## 7. IDE e uso pelo agente

Search Everywhere mantém lexical primeiro e estágio semântico adiado. Arquivos/símbolos independentes podem executar em paralelo sob budget compartilhado e publicar resultados progressivos; erro de um estágio não apaga os demais. Respostas superseded não alteram seleção, notices ou métricas da consulta atual.

A árvore continua virtualizada e com query de paths limitada. A UI diferencia carregando, vazio completo, parcial, índice atrasado, semântica indisponível e falha. Oferece refinamento/continuação/reconciliação apropriados; não obriga reindexar como solução universal.

O agente recebe fonte, revisão, linha e motivo de degradação em formato compacto. Evitar roundtrips obrigatórios para pedir status antes de toda busca: a resposta já carrega evidência suficiente. Expandir símbolo/corpo sob demanda e budget, preservando relação com a revisão pesquisada.

RAG não substitui leitura de contrato e call sites. Tarefa de localizar implementação avalia arquivos/linhas relevantes, não só similaridade textual. Não usar clique ou abertura de resultado como sinônimo de conclusão correta da tarefa.

## 8. Aceite e testes

| Cenário | Aceite observável |
|---|---|
| Crash antes/depois de commit e antes de ack | Recovery converge sem perder caminho nem apagar evento posterior. |
| Um arquivo falha em lote misto | Sucessos confirmados; falha permanece pendente ou explicitamente rejeitada. |
| Busca aquecida, save, drain e mesma query | Nova revisão é usada; conteúdo/símbolo antigo não reaparece via cache. |
| Rename/delete/ignore/branch | Cache, paths, FTS, referências e cobertura convergem juntos. |
| A indexado e B novo contêm o mesmo literal | Workspace encontra ambos ou declara cobertura parcial, mesmo com hit em A. |
| Query sem hits com disco cortado ou inacessível | Resposta parcial e motivo; nenhuma afirmação conclusiva de ausência. |
| Cancelamento em FTS/vector/hybrid/global | Não inicia nova etapa/projeto; efeito físico residual é acompanhado pelo owner. |
| Digitação rápida, troca de projeto e fechamento | Nenhuma resposta antiga aparece ou conta como resultado usado. |
| Projeto composto e dois projetos com paths iguais | Sem colisão de identidade, mistura de cache ou fuga de escopo. |
| Sem modelo, parser ou worker disponível | Estado e fallback explícitos; lexical utilizável quando possível. |
| Limites hostis de args e regex custosa | Budget físico/cancelamento funciona; main e renderer permanecem responsivos. |

Estender, em vez de duplicar, os testes seguintes:

- `packages/services/src/services/project-index/__tests__/project-index-service.test.ts`: leases, erros parciais e recovery sobre lifecycle/locks/watchers existentes.
- `packages/indexer/src/indexer/__tests__/structural-index.test.ts`: confirmação, revisão e integridade dos derivados.
- `packages/indexer/src/search/__tests__/hybrid-cache-revision.test.ts`: revisão estrutural além de geração/reranker.
- `packages/indexer/src/search/__tests__/hybrid-pipeline.test.ts` e `global-rerank.test.ts`: orçamento, cancelamento e proveniência.
- `packages/store/src/db/__tests__/file-path-search.test.ts`: qualidade e plano SQL em corpus grande isolado.
- `apps/mcp-server/tools/__tests__/search-diagnostics.test.ts`: completude, disco e projeção compatível.
- `apps/dashboard/e2e/ide-search-performance.spec.ts`: manter smoke mockado e acrescentar jornada com backend real descartável.
- `src/benchmarks/search-quality.ts`: reutilizar recall/MRR/nDCG com gold set congelado e separado do tuning.

O smoke atual da IDE usa API mockada e comprova virtualização/descarte, não latência real do backend. Testes existentes não foram executados nesta etapa de planejamento.

## 9. Avaliação, rollout e dependências

Corpus cobre 1 mil, 10 mil, 50 mil e 150 mil arquivos elegíveis, além de muitos assets ignorados; TS/React, PHP/Angular, C#/Unity e PT/EN. Separar cold/warm, índice vazio/parcial/stale, semântica off/on, mudanças externas e workspace composto. Usar fixtures descartáveis; projetos reais entram somente com autorização e isolamento adequados.

Medir p50/p95/p99 por etapa e ponta a ponta, save-to-search, candidatos/bytes realmente examinados, backlog/retries, RSS agregado, event-loop lag e tempo até primeira evidência útil. Qualidade inclui Recall@5/10, MRR, nDCG, referências corretas, stale hits, chamadas/tokens e sucesso do agente.

Comparar FTS, conteúdo, vetor, grafo, HyDE e reranker por ablação. Congelar holdout de consultas reais anonimizadas e tarefas verificáveis. Consultas autogeradas do próprio índice ajudam cobertura, mas não são prova independente de utilidade. As metas numéricas consolidadas e os critérios por hardware estão em [07](./07-implementacao-e-validacao.md).

Ordem: reproduções/telemetria -> IDX-01/02/03 -> cobertura e busca exata -> cancelamento e limites -> qualidade/ranking -> UX e release. Correção de perda de delta não espera tuning semântico. CTR-02/03/04/05 são dependências diretas; execução de grep/processos usa os contratos EXE de [04](./04-execucao.md).

Migração do journal e revisão é aditiva. Índices derivados incompatíveis usam geração paralela e troca atômica; não reconstruir tudo em cada abertura. Canário compara revisões, cobertura e utilidade antes de ampliar. Rollback preserva pendências/evidências e nunca restaura uma cópia antiga sobre alterações recentes do usuário.

Entrega termina com build empacotada e instalada exercitada após restart, incluindo indexação concorrente à edição/busca, falha de worker e retomada. Registrar commit, configuração, hardware, corpus, traces e limites restantes; build ou teste unitário isolado não comprova o resultado no produto.
