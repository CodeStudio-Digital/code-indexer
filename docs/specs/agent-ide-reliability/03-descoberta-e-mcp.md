# 03 — Descoberta de ferramentas e chamadas MCP

**Estado:** proposta, sem implementação nesta entrega. Baseline e limites de verificação: [README](./README.md).

## 1. Resultado esperado e fronteiras

O agente deve localizar uma capacidade adequada, receber seu contrato correto e conseguir invocá-la no próximo turno sem adivinhar nomes, repetir expansões ou interpretar Markdown como API. Cada chamada deve preservar identidade, autorização, dados estruturados, completude e estado do efeito.

Este documento cobre find_tools, expand_toolset, capability_catalog, a projeção de schemas ao provider, MCP interno/externo e uso dessas tools em code_exec. Indexação/ranking de código pertencem a [02](./02-indexacao-e-recuperacao.md); autoridade comum e envelopes pertencem a [06](./06-contratos-e-observabilidade.md).

O runtime vigente é TypeScript. A implementação usa os contratos existentes; não depende do runtime Rust removido. O lockfile resolve o SDK MCP 1.29.0: exemplos de SDK v2 não são especificação de implementação.

## 2. Estado atual verificado

| Componente | Infraestrutura existente | Referência no baseline |
|---|---|---|
| Descoberta | find_tools lexical com passagem strict/relaxed e cache WeakMap por identidade | packages/code-agent/src/tools/find-tools-score.ts:120 |
| Catálogo | capability_catalog com search/list/describe/activate, namespace, provenance e IDs | packages/code-agent/src/tools/capability-catalog-tool.ts:91 |
| Limites | Até 10 resultados, 8 ativações, 8 KiB por descriptor e 64 KiB no describe | packages/code-agent/src/tools/capability-catalog-tool.ts:24 |
| Projeção | Pins dinâmicos LRU de 16, teto de sessão padrão de 28 e ordem estável | packages/code-agent/src/tools/tool-pin-window.ts:19; core/runner/assembly/tools.ts:252 |
| Snapshot | Registry selado antes da execução da attempt | packages/code-agent/src/index.ts:2732 |
| MCP interno | Projeto injetado pelo bridge; contratos locais read/write/parallelSafe | packages/code-agent/src/tools/mcp-bridge.ts:64; internal-mcp-contract.ts:6 |
| MCP externo | Pool compartilhado, revisão de catálogo e revalidação antes do envio | apps/http-api/sse/mcp-external-pool-runtime.ts:135 |
| Efeitos | Dispatch com fence e sem replay automático após confirmação perdida | packages/code-agent/src/tools/mcp-wire-dispatch.ts:16; mcp-server-manager.ts:199 |
| Busca | mode=auto, semântica delegada ao owner e degradação para FTS | apps/mcp-server/tools/search.ts:159 |

Esses mecanismos devem ser corrigidos e integrados. A existência de cache, tiers e testes não prova qualidade de tarefa nem latência da aplicação instalada.

## 3. Achados que motivam a proposta

Os identificadores F-D/F-M abaixo são locais a este documento. São fatos de código; impactos de tempo/memória não medidos permanecem hipóteses.

| ID | Achado e evidência | Consequência |
|---|---|---|
| F-D01 | Tokenização usa apenas a-z/0-9; stopwords somente EN. find-tools-score.ts:22,46,95 | Consultas PT-BR e acentos não têm tratamento adequado. |
| F-D02 | Autopromoção depende de strict/top-1, sem margem para segundo candidato. find-tools.ts:195-211 | Empate por parâmetro genérico pode ativar arbitrariamente uma tool. |
| F-D03 | Três superfícies são registradas separadamente. index.ts:1026,1039,2080 | Descoberta, expansão e catálogo não usam uma única resolução de disponibilidade. |
| F-D04 | expand confirma desbloqueio antes do cap; assembly pode cortar pins/tools. expand.ts:149-160; assembly/tools.ts:264-288 | Tool anunciada como disponível pode não chegar ao provider. |
| F-D05 | Protected set pode exceder o teto local configurável modelMaxTools. assembly/tools.ts:283-289; providers/capabilities.ts:178-195 | É necessário distinguir limite físico validado do provider e soft caps; não foi reproduzida rejeição real do provider. |
| F-D06 | activate confirma next_turn, mas projectionDigest é null. capability-catalog-tool.ts:252,294 | Confirmação representa pin solicitado, não projeção efetiva. |
| F-D07 | paramSummary corta em ~90 caracteres; list_tools retorna toda superfície. find-tools.ts:282; code-exec.ts:1171 | Resumo insuficiente para chamada e fallback potencialmente volumoso. |
| F-M01 | tools/list retorna apenas primeira página, inclusive no modo lenient. mcp-catalog-listing.ts:50,61 | Tools posteriores a nextCursor desaparecem. |
| F-M02 | listAllTools percorre fontes em sequência. mcp-server-manager.ts:135-139 | Uma fonte lenta retarda descoberta das demais. |
| F-M03 | refresh reconstrói conexões; health check relista a cada 60s. mcp-external-pool-runtime.ts:100,299,405 | Trabalho repetido e perturbação de fontes saudáveis precisam ser medidos/corrigidos. |
| F-M04 | Todos externos recebem mutates=true e parallelSafe=false. mcp-server-manager.ts:175-177 | Postura conservadora impede paralelismo até haver classificação local confiável. |
| F-M05 | Bridge externo preserva structuredContent; interno geral extrai somente texto. mcp-server-manager.ts:311-325; mcp-bridge.ts:311-353 | Perda de dados estruturados antes de chegar a code_exec/UI. |
| F-M06 | search retorna Markdown. apps/mcp-server/tools/search.ts:204-234 | Consumidor precisa interpretar apresentação; metadados não chegam como contrato. |
| F-M07 | Grep só usa disco se não houver hits; glob enumera antes do cap. search.ts:52-82,341 | Arquivo novo pode faltar quando outro indexado já casou; cap de retorno não limita enumeração. |
| F-M08 | Grep lê arquivo integral sincronamente, sem signal no loop. packages/services/src/services/code-reader.ts:133-149 | Cancelamento e custo por arquivo não são controlados nessa camada. |

Reprodução isolada executada nesta análise: com read_file/write_file e parâmetro path, a consulta path empatou em score 4 e ambos passaram strict; ler arquivo obteve score zero; buscar referência virou tokens buscar/refer/ncia. Isso demonstra o comportamento do scorer, não uma taxa global de falha.

O SDK instalado confirma que listTools faz uma request e retorna a página; não percorre nextCursor automaticamente. Testes e comentários históricos com latências não foram tratados como benchmark atual.

## 4. Requisitos de descoberta

| ID | Requisito obrigatório | Aceite observável |
|---|---|---|
| DSC-01 | Um serviço interno de catálogo e resolução sustenta as três superfícies | Mesma consulta/escopo/revisão produz candidatos equivalentes nos adapters. |
| DSC-02 | Separar existência, autorização, disponibilidade, seleção e visibilidade | Descoberta/ativação nunca concede permissão nem modifica snapshot autorizado. |
| DSC-03 | Nome/ID exato e aliases controlados precedem ranking lexical | Nome único exato retorna a capacidade correta em primeiro lugar. |
| DSC-04 | Normalizar Unicode, acentos e identificadores; aliases PT-BR/EN | Gold set bilíngue cobre consultas naturais e parâmetros exatos. |
| DSC-05 | Autopromoção exige confiança e desambiguação | Empates e termos genéricos isolados não autopromovem. |
| DSC-06 | Confirmação de ativação deriva da projeção efetiva do próximo turno | Toda ativação confirmada aparece no schema enviado ou retorna motivo tipado. |
| DSC-07 | Hard limit do provider, soft cap e budget de schema são distintos | Nenhuma request ultrapassa o hard limit; configuração impossível falha antes. |
| DSC-08 | Descoberta/describe/listagem são limitados por itens e bytes | Nenhum caminho de fallback exige despejar catálogo inteiro. |
| DSC-09 | Índice de descoberta é cacheado por revisão e contexto autorizado | Sem reindexação completa por chamada; invalidação é testável e determinística. |
| DSC-10 | Compatibilidade é explícita e mensurada | Prompts/aliases antigos funcionam no período de migração e emitem evento de uso. |

### 4.1 Serviço comum e compatibilidade

Evoluir capability_catalog; não criar um quarto catálogo. Extrair resolução compartilhada no domínio code-agent antes de decidir por package novo.

find_tools permanece fachada de busca, com retorno compacto e ativação de candidato inequívoco quando a política da superfície permitir. expand_toolset resolve tools da família dentro do budget e informa itens efetivos, omitidos e motivos. Não anuncia que toda família está visível quando não está.

O tier continua classificação/compatibilidade, não permissão. Chamadas antigas com tier e reason são aceitas durante a migração. Uma expansão já ativa deve indicar a situação da projeção, em vez de somente responder already active.

tool_schema hidrata o contrato executável por ID/nome validado. paramSummary é preview; não deve ser descrito como todos os argumentos necessários. list_tools em code_exec recebe query/namespace/cursor/limit opcionais e paginação bounded, preservando compatibilidade documentada da chamada sem argumentos.

### 4.2 Ranking útil

Pipeline proposto: validar input -> resolver exato/alias -> filtrar snapshot/namespace -> recuperar candidatos lexicais -> ordenar -> estimar ambiguidade -> projetar resultados.

- Preservar nome original para execução; normalização serve somente à busca.
- Separar snake_case, camelCase e hífens; normalizar Unicode e acentos para recall.
- Versionar aliases PT-BR/EN por capacidade: ler/read, buscar/search/find, banco/database e esquema/schema.
- Indexar campos semânticos positivos separados de exemplos, avisos e instruções operacionais.
- Aplicar frequência de termos/IDF para reduzir peso de path, query, limit e id.
- Ordenar por match exato, relevância e identidade estável; visibilidade não deve vencer relevância material.
- Exibir matchedFields/confidence/reason de forma limitada; nenhum texto explicativo inventa evidência.
- Manter consultas negativas e ambíguas no corpus para avaliar abstinência, não apenas recall.

Construir índice lexical por catalogRevision no seal. Comparar lexical com aliases contra baseline antes de introduzir embeddings. Semantic opcional só será considerado com ganho demonstrado no corpus e custo amortizado; não gerar embeddings do catálogo a cada turno.

### 4.3 Receipt de ativação e projeção

Proposta interna compatível com [06](./06-contratos-e-observabilidade.md):

~~~ts
interface ActivationReceiptV2 {
  version: 2;
  catalogRevision: string;
  authorizationRevision: string;
  requestedIds: string[];
  visibleNextTurnIds: string[];
  rejected: Array<{ id: string; code: string; reason: string }>;
  evictedIds: string[];
  projectionDigest: string | null;
  projectionState: 'resolved' | 'pending_projection';
  schemaBytes: number;
  estimatedSchemaTokens: number;
  modelToolLimit: number;
  sessionToolLimit: number;
}
~~~

O mesmo resolvedor calcula receipt e monta a request seguinte. Se ainda não calculou a projeção, retorna pending_projection e não afirma visibilidade. Schema/ordem/digest permanecem estáveis sem mudança explícita.

Códigos mínimos: not_in_attempt_snapshot, blocked_by_policy, source_unavailable, schema_budget_exceeded, model_tool_limit e invalid_capability. Evitar conflar catálogo antigo com erro de permissão.

A seleção reserva núcleo mínimo e slots dinâmicos; não protege uma família inteira apenas porque seu tier foi expandido. Se o conjunto obrigatório realmente não couber no provider, falhar preflight de forma acionável. Não omitir silenciosamente ferramentas essenciais nem exceder limite físico.

## 5. Requisitos MCP

| ID | Requisito obrigatório | Aceite observável |
|---|---|---|
| MCP-01 | Consumir catálogo paginado com dedupe e orçamento | Todas as tools válidas da fixture aparecem; cursor repetido termina sem loop. |
| MCP-02 | Discovery tem cancel/deadline e concorrência limitada por fonte | Fonte lenta não bloqueia publicação de fontes saudáveis além do orçamento delas. |
| MCP-03 | Refresh por diferença preserva fontes saudáveis | Alteração de B não fecha transporte A nem invalida schema idêntico sem motivo. |
| MCP-04 | Revisão publicada e snapshot da attempt são distintos | Fonte tardia fica disponível na próxima resolução; chamada admitida não troca handler. |
| MCP-05 | Dados estruturados/anexos/truncation atravessam todos os adapters | Paridade semântica direto, bridge interno, externo, worker e code_exec. |
| MCP-06 | Deadline/cancelamento/efeito são estados separados | Cancelar espera não confirma fim físico ou rollback; unknown impede replay. |
| MCP-07 | Paralelismo/retry derivam de contrato local versionado | Hint remoto ou nome search nunca reduz postura automaticamente. |
| MCP-08 | Limites aplicam antes/durante aquisição e serialização | Payload/filas/fontes acima do budget encerram com diagnóstico e evidência parcial. |
| MCP-09 | Search/grep expõem evidência, cobertura e revisão estruturadas | Zero hits com scan parcial não é apresentado como prova de ausência. |
| MCP-10 | Compatibilidade de protocolo e SDK é testada | Fixtures cobrem versão negociada, schema inválido, formato legacy e capacidades ausentes. |

### 5.1 Catálogo e conexões

Percorrer nextCursor com limites de páginas, tools, bytes e deadline absoluto. Deduplicar por identidade da fonte + nome original; detectar ciclos de cursor. Validar cada definição, isolando malformed tools sem descartar irmãs válidas. Catálogo parcial informa motivo e completude.

Consultar fontes independentes com concorrência bounded. Conexão, listagem e espera de readiness possuem budgets próprios dentro do prazo total de launch. Fonte opcional indisponível gera diagnóstico; fonte requerida falha de forma tipada.

Configuração alterada reconcilia apenas fonte afetada. Comparar configRevision/schemaDigest sem persistir credencial ou hash reutilizável de segredo. Preservar transportes saudáveis e revalidar revisão/fence no envio físico.

Usar notifications/tools/list_changed quando negociado/suportado; manter polling com backoff e jitter como fallback. Agrupar rajadas de notificações e não publicar revisão diferente quando conteúdo efetivo é idêntico.

Um snapshot antigo pode explicar o que existia, mas não autoriza dispatch após revogação. Cache de catálogo não é cache de autorização. Não reaproveitar entradas entre tenants/credenciais incompatíveis. A UI mostra revisão, fonte indisponível e disponibilidade apenas na próxima attempt.

O protocolo MCP 2025-06-18 define paginação em tools/list, listChanged e structuredContent; annotations externas não são autoridade por si. A implementação deve respeitar a versão negociada e as APIs do SDK instalado. [Contrato oficial de tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools).

### 5.2 Execução, cancelamento e retries

Preservar withMcpWireDispatch e proteção de efeito desconhecido. Instrumentar admissão, fila, início físico, primeiro byte, conclusão e serialização. O deadline absoluto acompanha a chamada e cada retry usa apenas o saldo restante.

Retry automático somente antes do envio ou para leitura/idempotência comprovada localmente. Após confirmação perdida de mutação, retornar unknown e reconciliar a operação original; nunca criar tentativa equivalente às cegas.

Atestação local versionada pode declarar leitura, idempotência, recursos acessados e concorrência. Na ausência dela, manter a postura conservadora atual dos MCP externos. Paralelizar apenas operações independentes; serializar conflitos por recurso.

AbortSignal deve chegar ao transporte e ao produtor quando suportado. Registrar cancel_requested, terminal confirmado e cleanup pendente separadamente. A notificação MCP pode ser ignorada quando não cancelável ou já concluída; portanto não comprova interrupção física. initialize não recebe cancel notification. [Cancelamento oficial](https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/cancellation).

Coalescer leituras equivalentes apenas no mesmo escopo/revisão, mantendo cancelamento por waiter e resultado individual. Não coalescer mutações, chamadas voláteis ou operações com parâmetros cuja equivalência não seja provada.

### 5.3 Resultado estruturado e outputs

O produtor MCP fornece structuredContent quando o formato negociado permitir. Bridge converte para structuredData local sem perder content, blocos suportados, sourceTruncations e classificação do efeito. O bridge interno deve atingir a paridade já parcial do externo.

Validar outputSchema quando fornecido e suportado. Erro de schema não vira sucesso silencioso; preservar evidência limitada para diagnóstico. Formato legacy mantém projeção textual documentada. Internamente não duplicar JSON integral e Markdown integral no histórico.

code_exec recebe structuredData pelo contrato comum de [04](./04-execucao.md); não deve depender de regex/JSON.parse sobre texto decorativo. Erros mantêm códigos e conteúdo útil; truncation informa se recuperação é por artefato, cursor, nova execução ou impossível.

O guard patológico de 8M caracteres continua defesa final, mas não substitui limite de bytes no transporte, validação de JSON, quota de anexos e spool bounded. Não anunciar recoverable quando o produtor já descartou os dados.

## 6. Busca útil com mcp__search e ferramentas relacionadas

Manter search como entrada de busca por intenção e grep_code para literais/padrões. Não ressuscitar aliases search_concepts/search_by_kind sem necessidade demonstrada. Evitar roteiro fixo que obrigue pulse + search + skeleton + body em toda pergunta.

| Intenção | Caminho preferencial proposto | Evidência suficiente |
|---|---|---|
| Arquivo/nome exato | path/symbol lookup ou grep literal | Path, revisão e range atual. |
| Explicação conceitual | search auto com filtros e budget | Trechos relevantes, origem lexical/semântica e degradação. |
| Relação entre símbolos | referências/dependências após resolver identidade | IDs/ranges e cobertura do grafo. |
| Preparar alteração | Contexto focalizado/prepare_edit quando necessário | Conteúdo atual e dependências pertinentes, sem dump de repositório. |
| Índice incompleto | Fallback bounded no working tree | Cobertura e limitações explícitas; não exigir rebuild para leitura simples. |

search/grep devem produzir dados tipados com query normalizada, effectiveMode, projectId, generation/revision, itens com path/range/snippet, evidence, freshness, coverage, diagnóstico e continuação quando suportada. Usar contratos de [02](./02-indexacao-e-recuperacao.md) e [06](./06-contratos-e-observabilidade.md), sem criar outro modelo de resultado.

Validar query, enum, inteiros finitos e limites antes de overfetch. Um teto de resultados não limita leitura de disco ou trabalho vetorial; aplicar budget aos produtores. Cursor é opaco e vinculado a query/escopo/revisão; geração incompatível retorna erro explícito.

Grep atual deve distinguir busca no snapshot indexado de busca no working tree. Arquivos novos/dirty precisam ser considerados mesmo quando já existem hits indexados. Enumeração deve parar no budget e informar cobertura, em vez de enumerar tudo e cortar depois.

Avaliar worker cancelável ou rg encapsulado sem shell string para grep. A escolha exige paridade de regex/literal, Unicode, ignores, symlinks, paths Windows e empacotamento. Não trocar engine antes de medir o caminho atual e validar compatibilidade.

## 7. Validação e critérios de aceite

### 7.1 Correção obrigatória

1. Fixture de catálogo paginado inclui todas as tools válidas, sem duplicação; cursor repetido, timeout e malformed sibling são tratados.
2. Toda ativação confirmada está na próxima projeção; provider estrito consegue chamar a tool sem expand repetido.
3. Nenhuma request excede hard count/schema budget; conjunto obrigatório impossível falha antes do provider.
4. Consultas exatas únicas têm top-1 correto; empate genérico não autopromove; PT-BR com acento conserva o conceito.
5. direct/nested/MCP interno/externo preservam structuredData, truncation e erro com dado parcial.
6. Refresh de B não fecha A; revisão aposentada e permissão revogada bloqueiam antes de enviar.
7. Mutação com resposta perdida tem exatamente um envio e estado unknown, sem retry automático.
8. Busca com índice stale + arquivo novo + dirty overlay retorna evidência atual ou declara cobertura incompleta.
9. Cancelamento/timeout não deixam chamada física sem owner/registro; não confundem efeito desconhecido com rollback.

### 7.2 Qualidade e desempenho

O corpus deve conter consultas PT/EN, exatas, conceituais, ambíguas, negativas e nomes semelhantes, com respostas esperadas revisadas. Medir Recall@5/MRR, primeira tool correta, primeira chamada válida, descoberta por tarefa, tokens de schema/output e sucesso de tarefa.

As metas numéricas, hardware, tamanhos de catálogo, amostragem e gates comuns são definidos em [07](./07-implementacao-e-validacao.md). Os testes atuais de fixture pequena não sustentam uma afirmação de qualidade global. Não aprovar redução de tokens que diminua sucesso ou esconda evidência.

Medir cold/warm separadamente, catálogo 100/500/2.000/10.000 e fontes lenta/offline/paginada. Comparar tempo da descoberta local com espera de readiness externa. Reportar p50/p95/p99, bytes, event-loop lag e RSS agregado.

### 7.3 Base de regressão existente

Ampliar tests de tools: find-tools, find-tools-score, find-tools-params, capability-catalog-tool, runtime-tool-tiers, tool-priority, tool-pin-window, mcp-server-manager, mcp-server-lifecycle, mcp-bridge-project-name e mcp-bridge-deferred.

Ampliar tools-membership-sticky em core/runner/assembly/__tests__; worker-mcp-calls e mcp-lost-ack em apps/http-api/sse/__tests__; semantic-search-delegation, search-diagnostics, truncation-metadata e mcp-tool-contract em apps/mcp-server/tools/__tests__.

Adicionar jornadas com provider estrito e aplicação Electron empacotada. Testes puros e build não demonstram que expansão, cancelamento e descoberta funcionam no produto instalado.

## 8. Implementação e limites da entrega

Ordem: baseline/corpus -> paginação e structuredData -> receipt/projeção verdadeira -> convergência dos adapters -> ranking/budgets -> refresh por fonte -> paralelismo atestado e otimizações de busca. Correções determinísticas pequenas não dependem do benchmark completo.

Rollout usa versão de contrato e comparação em shadow para leituras/resolução, nunca dupla execução de mutações. Rollback restaura resolução anterior preservando formatos/evidências, sem reativar bypass de fence, revogar proteção de unknown ou sobrescrever dados do usuário.

Esta análise verificou código e reproduziu scorer puro. Não executou servidor externo, chamada paga de provider, benchmark de IDE instalada ou reindexação. A melhoria só estará entregue depois dos gates de [07](./07-implementacao-e-validacao.md).
