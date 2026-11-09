# 06 — Contratos comuns, orçamento e observabilidade

## 1. Princípio de integração

Estender os contratos existentes, mantendo domínio e autoridade claros. `packages/agent-runtime-host/src/tool-result.ts` já define `ToolResult`, `ToolErrorInfo`, `effectOutcome`, `structuredData`, políticas de output e `sourceTruncations`. `packages/code-agent/src/core/capability-catalog.ts` já deriva descriptors e sanitiza metadados externos. Nenhuma proposta deste documento exige substituir tudo por um envelope incompatível.

Os schemas abaixo são **propostas de versão nova**, não APIs já disponíveis. Campos novos entram de forma aditiva e são adaptados nas bordas. O contrato público MCP permanece o negociado pelo protocolo; metadados internos não devem ser expostos arbitrariamente como novos campos MCP.

## 2. Requisitos transversais

| ID | Requisito | Verificação |
|---|---|---|
| CTR-01 | Versão explícita de contrato e identificador estável de operação | Golden fixtures e compatibilidade produtor/consumidor. |
| CTR-02 | Revisões independentes para catálogo, autorização e dados | Cache/snapshot invalidam pelo motivo correto; sem autorização obtida de cache. |
| CTR-03 | Budget aplicado antes e durante aquisição | Memory/bytes/rows/calls observados respeitam limite, não apenas tamanho inline. |
| CTR-04 | Deadline e cancelamento propagados até o dono físico | Não há chamada filha viva sem registro depois do término lógico. |
| CTR-05 | Saída incompleta e efeitos desconhecidos são explícitos | UI/agente não apresentam conclusão ou ausência total sem evidência. |
| CTR-06 | Telemetria útil sem conteúdo sensível por default | Eventos redigidos e cardinalidade limitada; teste com segredos sentinela. |
| CTR-07 | Execução direta, nested, API e UI mantêm as mesmas invariantes | Matriz diferencial por origem. |

## 3. Identidade e revisões

```ts
type InvocationOwnerV2 =
  | { kind: 'agent'; sessionId: string; runId: string; attemptId: string }
  | { kind: 'ide' | 'api' | 'cli'; interactionId: string; principalId: string };

interface InvocationContextV2 {
  version: 2;
  invocationId: string;
  parentInvocationId?: string;
  owner: InvocationOwnerV2;
  projectId?: number;
  toolId: string;                  // identidade canônica, não descrição
  catalogRevision: string;
  authorizationRevision: string;
  deadlineAtEpochMs: number;
  cancellationId: string;
  traceId: string;
}

interface ResourceVersion {
  projectGeneration?: string;
  structuralRevision?: number;
  semanticGeneration?: string;
  semanticRevision?: number;
  connectionRevision?: number;
  schemaRevision?: string;
}
```

Não inferir identidade de projeto pelo basename nem de servidor MCP pelo nome da tool. IDs canônicos preservam nomes originais e display names. Renomear projeto não troca identidade; trocar raiz, credencial ou permissões invalida o estado apropriado.

`projectId` e `connectionId` mantêm os IDs numéricos locais existentes; `connectionRevision` é um contador monotônico persistido. IDs textuais externos exigem adapter explícito, sem coerção silenciosa. `timeoutMs` pode existir na entrada pública, mas é convertido uma vez no host em `deadlineAtEpochMs`; cada camada usa o saldo desse mesmo deadline. Chamadas da UI/API usam owner de interação real, sem fabricar uma sessão de agente. Revogação e permissões aplicam-se igualmente aos dois tipos de owner.

No início da attempt, registrar catálogo e conjunto autorizado. A disponibilidade pode degradar imediatamente, e revogação bloqueia antes do dispatch. Atualização de catálogo é publicada atomicamente em uma fronteira explícita; não muda schema/handler de uma chamada já admitida. Nova autorização requer nova resolução explícita, não uma resposta de `find_tools`.

### Cache

Chave mínima por domínio: identidade + query/args normalizados + revisão de dados relevante + filtros + formato + contexto de acesso. Paginação e ranking têm versão. Nunca incluir credencial em claro na chave ou log; usar versão da configuração, não hash reutilizável de segredo.

Cada cache tem: owner, limite de entradas/bytes, TTL como proteção adicional, política de invalidação e métrica de stale hit. Cache negativo usa retenção curta e invalidação por revisão. Não cachear mutação, resultado de autorização ou estado de processo como se fosse leitura estável.

Coalescer chamadas simultâneas equivalentes apenas se forem leituras idempotentes no mesmo escopo e revisão. Cada waiter mantém cancelamento próprio; cancelar um não cancela o trabalho ainda necessário a outros. O último waiter pode cancelar o produtor. A resposta deve preservar um resultado de protocolo por chamada solicitada.

## 4. Resultado e completude

```ts
interface ResultEvidenceV2 {
  version: 2;
  invocationId: string;
  state: 'succeeded' | 'failed' | 'refused' | 'cancelled' | 'timed_out';
  effect: 'none' | 'confirmed' | 'unknown';
  completeness: 'complete' | 'partial';
  dataVersion?: ResourceVersion;
  truncations?: Array<{
    unit: 'bytes' | 'rows' | 'items' | 'lines';
    observed: number;
    observedExact: boolean;
    returned: number;
    reason: string;
    recovery: 'artifact' | 'cursor' | 'rerun' | 'none';
    outputRef?: string;
  }>;
  timings: { queueMs: number; executionMs: number; serializationMs: number; totalMs: number };
}
```

Mapear aos campos atuais de `ToolResult`, adicionando evidence versionada onde necessário. `isError` e `error` permanecem compatíveis. Não usar `state:'cancelled'` para sugerir reversão de uma mutação; `effect:'unknown'` prevalece para impedir retry.

Preservar todas as entradas atuais de `sourceTruncations`, inclusive cortes simultâneos de linhas, células e texto. `effect` é somente um resumo transversal: o outcome do domínio continua presente. Para database, `applied`, `partially_applied` e `rolled_back` mantêm seus valores em `DbPage.outcome`; nunca reduzir os três a sucesso genérico. `partially_applied` exige estado de falha/parcial e bloqueio de replay; `unknown` mapeia sempre para `effect:'unknown'`. Rollback confirmado informa exatamente qual transação foi revertida, sem prometer desfazer efeitos externos.

Um resultado pode conter evidência útil mesmo em falha parcial. Leitura com zero hits e cobertura incompleta não prova ausência. Banco com limite de 100 linhas não declara que a tabela tem exatamente 100 linhas. Progresso 100% de uma fase não significa que o projeto inteiro está pronto.

`structuredData` é a representação canônica local; `content` é o resumo para modelo/usuário. Em MCP, preservar `structuredContent` e blocos suportados, com adaptação validada. Um output grande passa por store/paginação sem duplicar conteúdo integral no histórico. Se o produtor descartou dados, o finalizador não inventa referência recuperável.

IDs de output/cursor são opacos, vinculados a owner/escopo/revisão, com expiração e proteção contra acesso cruzado. Cursor de artefato é leitura da mesma fotografia; cursor de query declara suas garantias de consistência. Reexecutar query nunca é anunciado como recuperar o mesmo snapshot.

## 5. Scheduler e budgets

Adotar budget hierárquico: aplicação -> recurso físico -> sessão -> run -> batch -> invocação. Definir classes interativa, tarefa do agente, backfill e manutenção. Reservar capacidade interativa; aplicar aging para background não sofrer starvation.

| Recurso | Owner | Unidade de contenção |
|---|---|---|
| Indexação | Coordenador de projeto/worker | Tempo de CPU, arquivos/bytes por lote, fila de deltas |
| Inferência | Serviço semântico/worker | Chamadas em voo, lote e memória do modelo |
| MCP | Pool por servidor e conjunto de acesso | Conexões, chamadas, tentativas, bytes |
| Processos | Serviço de execução | Árvores possuídas, CPU/memória, output e tempo |
| Database | Driver/pool por connectionRevision | Leases, queries/cursors, rows/bytes, transações |

Somar limites aninhados. Um batch de quatro chamadas de banco não pode abrir quatro pools novos. Filas têm capacidade e admissão explícita; saturação retorna motivo e retry-after para operações que aceitam retry. Não usar filas ilimitadas para esconder sobrecarga.

Um deadline absoluto acompanha a chamada. Retries de leitura transitória têm limite, backoff com jitter e teto do deadline original. Mutação sem recibo confirmado não recebe retry automático; idempotência requer contrato explícito no executor e chave estável.

## 6. Autoridade de execução

Fluxo único: resolver identidade -> validar schema -> normalizar uma vez -> calcular metadados locais -> verificar autorização/fence -> reservar capacidade -> revalidar no limite físico -> executar -> classificar efeito -> armazenar evidência -> projetar resultado.

Metadados de MCP/plugins são entrada não confiável. `readOnlyHint` ou nome contendo `search` não bastam para autorizar paralelismo ou evitar approval quando o classificador local exige. Política deve continuar derivada da operação e argumentos efetivos. Em database, classificador sintático e configuração read-only do servidor/driver se complementam.

O dispatcher comum não precisa começar como novo package: extração em `code-agent` e contratos em seus donos atuais reduz movimentos simultâneos. A decisão de package separado ocorre somente depois da fronteira estar provada. UI e API delegam à mesma camada de serviço, sem importar detalhes do renderer para workers.

## 7. Observabilidade

Cada trace liga: entrada do usuário -> descoberta/seleção -> montagem de schemas -> chamada -> fila -> trabalho físico -> redução -> resultado -> verificação da tarefa. Não coletar cadeia de pensamento; somente eventos observáveis e resultados verificáveis.

Eventos propostos: `index.delta_received`, `index.batch_ack`, `index.batch_retry`, `search.finished`, `catalog.refreshed`, `discovery.ranked`, `projection.resolved`, `tool.admitted`, `tool.physical_finished`, `tool.outcome_unknown`, `process.cleanup`, `db.query_finished`, `output.reduced`.

Campos permitidos: IDs opacos, versões, fonte da chamada, engine/categoria, status, contagens, tamanhos, tempos, cache hit e fallback reason. Query, SQL, comandos, paths completos, parâmetros, credenciais e resultados não vão para telemetria operacional por default. Diagnóstico detalhado local é opt-in, limitado e redigido; exemplos de teste usam dados sintéticos.

| Dimensão | Métricas |
|---|---|
| Utilidade | Recall/MRR/nDCG, primeira tool correta, primeira chamada válida, sucesso da tarefa, correções humanas |
| Frescor | Save-to-search, idade da revisão, cobertura estrutural/semântica, deltas sem ack e reconciliados |
| Custo | Chamadas solicitadas/executadas/coalescidas, tokens de schema/input/output, tempo até primeira evidência útil |
| Responsividade | p50/p95/p99 de UI/API, event-loop lag, long tasks e fila interativa |
| Recursos | RSS agregado e por processo, heap/buffers, CPU, I/O, conexões/queries/processos vivos |
| Confiabilidade | Timeouts físicos/lógicos, cancel não confirmado, unknown, stale response, retry e cleanup incompleto |

Proposta inicial de retenção: eventos detalhados locais por sete dias ou 100 MiB, o que ocorrer primeiro; agregados por 30 dias; fixtures sem segredos versionadas. Ajustar após medir volume. Logs de comando/consulta são artefatos separados com retenção/quota explícitas e não entram em métricas por cópia.

## 8. Compatibilidade e migração

Consumidores antigos seguem recebendo texto e campos atuais. Contratos v2 são negociados por capacidade no adapter; versão não suportada retorna erro explícito ou projeção legacy documentada. Não converter payload incompatível silenciosamente.

Testar respostas vazias, erro com dado parcial, MIME/bloco não suportado, JSON inválido, outputSchema inválido, enum novo, campos opcionais e payload acima do limite. Compatibilidade entre providers cobre limite de nomes, quantidade e bytes de schemas, e suporte a multimodalidade.

Schemas de dados/índice são versionados com migração aditiva e backup local controlado. Reconstrução de índice derivado usa geração paralela e troca atômica. Bancos externos dos usuários não recebem migrations automáticas por esta spec.

O rollback preserva evidências e formatos legíveis. Nunca restaura um snapshot antigo sobre alterações do usuário feitas depois da atualização. Jobs podem retomar somente com ownership e revisão validados; efeitos externos incertos ficam para reconciliação.
