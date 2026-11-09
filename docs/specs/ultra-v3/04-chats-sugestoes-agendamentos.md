# 04 — Chats, sugestões e agendamentos

## C-01 — Quatro identidades, um ciclo de trabalho

Preservar a distinção entre `Session` (chat durável), `AgentRun` (execução), `WorkItem` (unidade lógica com aceitação) e `ToolInvocation` (operação). Subagente efêmero, chat filho visível e execução de rotina podem executar WorkItems, mas não têm o mesmo lifetime nem a mesma presença no sidebar.

Cada entidade tem owner, parent opcional e origem `human | agent | schedule | recovery`. Origem é metadado autenticado pelo host, não texto do prompt. Mensagem de outro agente não pode declarar-se humana, fornecer consentimento ou encaminhar uma operação negada a outro ator para obter permissão.

Adapters preservam ferramentas atuais de subagentes, chats e Company. Eles compartilham envelopes/eventos/esperas/orçamento; não fundem permissões, escopos de projeto ou hierarquias Company indiscriminadamente.

## C-02 — Envelope, entrega e resposta

```ts
interface CoordinationMessage {
  schemaVersion: 2;
  messageId: string;
  idempotencyKey: string;
  from: { actorId: string; generation: number };
  to: { actorId: string; generation: number };
  kind: 'notify' | 'question' | 'task' | 'response' | 'control';
  requestId?: string;
  replyTo?: string;
  origin: 'human' | 'agent' | 'schedule' | 'recovery';
  authorizationRef: string;
  body: string;
  artifactRefs: string[];
  createdAt: string;
  expiresAt?: string;
  hopCount: number;
}
```

Estados distintos: `accepted` (persistida), `queued`, `delivered` (injetada/confirmada pela fronteira), `started` (turno receptor iniciou), `answered`, `rejected`, `expired`, `cancelled`, `delivery_unknown`. A UI pode condensá-los, mas não trocar seus significados. `idle` do receptor não significa tarefa concluída.

Fluxo obrigatório: validar destinatário/geração/link/policy → deduplicar → persistir mensagem → registrar evento → notificar host → entregar na fronteira apropriada → ACK por ID → correlacionar eventual resposta. Se um hook altera destinatário, conteúdo efetivo ou tipo, reavaliar a autorização antes do envio.

Uma chave idempotente repetida com payload idêntico retorna o recibo anterior. A mesma chave com payload diferente é conflito, não sobrescrita. A resposta deve referenciar request existente e destinatário válido. Mensagem para si ou para nome ambíguo é erro explícito; recriar ator com o mesmo nome não reutiliza sua geração.

Confirmar apenas IDs efetivamente consumidos; mensagens que chegaram depois permanecem pendentes. Não converter erro de parsing em mailbox vazia. Preservar bytes corrompidos, marcar degradação e oferecer recuperação limitada.

Persistência em filesystem continua canônica. Acrescentar índice derivado por destinatário/correlação/seq, segmentação e retenção; evitar ler todo o diretório para cada `pending`. Índice é reconstruível. Tombstones de dedup devem durar pelo menos o horizonte de retry/replay; GC não pode reabilitar duplicação antiga. Compartilhar watcher por store e fazer fan-out aos assinantes.

## C-03 — Espera com motivo, cursor e fronteira explícita

```ts
interface WaitRequest {
  targets: { id: string; generation: number }[];
  predicate: 'any_terminal' | 'all_terminal' | 'response' | 'idle';
  requestId?: string;
  afterCursor?: string;
  maxWaitMs: number;
}
interface WaitResult {
  reason: 'event' | 'timeout' | 'cancelled' | 'expired' | 'needs_input'
    | 'target_gone' | 'cycle_detected' | 'cursor_expired';
  events: { eventId: string; seq: number; type: string; targetId: string; payloadRef?: string }[];
  nextCursor: string;
  snapshot: { targetId: string; state: string; runId?: string }[];
}
```

`maxWaitMs=0` consulta snapshot; limite inicial de 60 s por chamada. Esperas longas se representam por subscrição/timer durável, sem manter chamada ao modelo. Timeout retorna estado sem alterar execução observada. Abort elimina listener/timer e retorna `cancelled`; não devolve o mesmo `[]` usado para todos os casos.

Registro da subscrição e leitura dos eventos usam sequência/handshake sem janela de perda entre snapshot e subscribe. Cursor identifica stream e geração; expiração retorna `cursor_expired` e snapshot de reconciliação, nunca ausência conclusiva.

Persistir eventos de conclusão, em vez de apenas “última conclusão por sessão”. Duas execuções que terminam antes do consumidor ler precisam ficar distinguíveis. Predicados falha/conclusão não devem se apoiar apenas em `reason === 'error'`; mapear falha, cancelamento, limite, parcial e `needs_input` para o contrato comum.

Manter detector de ciclos de espera; registrar dependências por run/request. Bloqueio circular retorna os participantes para o coordenador desfazer uma aresta. Não resolver deadlock lançando novos agentes automaticamente.

## C-04 — Acordar por evento sem criar pingue-pongue

Um evento relevante gera `WakeIntent` persistido, com `sourceEventId`, alvo, run/objetivo, orçamento e epoch de stop. Claim idempotente precede admissão do novo turno. Eventos iguais ou várias conclusões próximas podem ser agrupados num resumo, conservando seus IDs.

Regras de admissão:

- Prioridade à entrada humana e às decisões pendentes. Não sobrepor duas execuções na mesma sessão.
- Não acordar sessão parada pelo usuário, arquivada, fora do escopo ou com autorização revogada.
- Uma notificação de progresso comum não acorda o modelo. Acordar por resposta aguardada, dependência satisfeita, falha acionável ou horário autorizado.
- O join considera dependências reais. Não esperar todos os irmãos quando o próximo passo depende de apenas um deles.
- O budget da raiz cobre wakes; limite inicial adicional de 10 continuações automáticas sem mensagem humana. Essa é uma proteção proposta, não o limite atual da nossa rede. Alcançá-la estaciona e informa o motivo.
- Mensagem humana pode redefinir a intenção e o contador de ciclos; não restaura um orçamento financeiro esgotado nem revoga stop de outra tarefa por acidente.
- Retry transitório usa backoff limitado e o mesmo ID. Após resultado incerto, reconciliar; não reenviar cegamente.

Retomada usa os canais normais do writer/runner, herdando histórico e política, em vez de uma rota privilegiada que injeta “nova autorização”. A varredura periódica de recuperação do host pode existir como backstop; não deve produzir chamadas LLM quando não há novidade.

## S-01 — Separar sugestões, propostas e rotinas

| Entidade | Finalidade | Execução automática |
|---|---|---|
| `PromptSuggestion` | Texto curto que o usuário talvez queira enviar | Nunca; preencher/selecionar não é enviar |
| `TaskProposal` | Trabalho adicional concreto, com contexto e entregável | Só por aceitação ou autorização humana já aplicável e registrada |
| `ScheduledTrigger` | Retomar objetivo ou executar rotina no futuro | Somente dentro do escopo do agendamento autorizado |

No CLI, sugestão de prompt é gerada sem ferramentas, com cancelamento, filtros e supressão por estado/custo; no Desktop, proposta tem fila, expiração e claim. Esses são fluxos separados. Evidências C14 e D01–D03.

## S-02 — Sugestão de prompt discreta

Uma sugestão é opcional, ligada a `sessionId + turnId + contextRevision`. Deve ajudar a expressar uma continuação evidente, não criar obrigação ou inventar escopo. Pode ser vazia. Não sugerir confirmação de sucesso quando há erro, nem uma permissão ambígua como “sim” sem referenciar o pedido correto.

Geração usa contexto mínimo, sem tools, com custo contabilizado e timeout curto. Nova mensagem, mudança de revisão, stop, input/permissão pendente ou fechamento da sessão cancelam ou invalidam o resultado. Resultado atrasado não reaparece sobre outra conversa. Aceitação apenas preenche o composer; envio humano segue o fluxo normal.

Preferência de desligar e rejeições repetidas reduzem frequência. Não persistir sugestões como mensagens enviadas. Sem suportar cache barato nesse provider, preferir regra local/artefato já produzido ou não sugerir, em vez de uma chamada cara para cada resposta.

## S-03 — Proposta de tarefa com estado próprio

```ts
interface TaskProposal {
  proposalId: string; revision: number;
  sourceSessionId: string; sourceTurnId: string;
  initiation: 'user_requested' | 'offer' | 'agent_proposed';
  title: string; rationale: string; deliverable: string;
  prompt: string; contextRefs: string[];
  projectId: string; workspaceRevision?: string;
  contextMode: 'fresh' | 'fork';
  workspaceMode: 'shared_read' | 'isolated';
  estimatedSize: 'small' | 'medium' | 'large' | 'unknown';
  state: 'proposed' | 'accepted' | 'starting' | 'started'
    | 'dismissed' | 'expired' | 'stale' | 'failed';
  expiresAt: string;
  childSessionId?: string;
  authorizationRef?: string;
}
```

Uma proposta precisa de evidência/motivo, entregável e contexto suficiente para outra sessão. Não repetir apenas “melhorar qualidade”. Não sugerir como opcional um requisito obrigatório ainda não cumprido no pedido atual. Deduplicar por projeto, objetivo e artefatos; no máximo três cards visíveis e vinte pendentes por sessão como defaults de produto.

Botões: **Fazer aqui**, **Abrir nova sessão**, **Dispensar**. Explicar escopo e isolamento; opções técnicas avançadas podem mostrar modelo/effort herdados. Não criar silenciosamente uma sessão cloud ou trocar de repositório. `fresh` leva briefing/referências; `fork` leva histórico conforme consentimento/contexto apropriado. Nenhum exige copiar todos os arquivos.

Aceitar usa `proposalId + revision + idempotencyKey`. Transação/claim durável impede duplo clique e corrida entre UI e agente. Persistir intenção de início; criar sessão; persistir ligação; só então marcar `started`. Após crash entre criar e vincular, procurar pela chave de criação antes de criar de novo. A implementação de claim em memória vista no Desktop inspira o fluxo, mas não prova esta garantia após crash; aqui ela é um requisito novo.

Alterar destino, escopo de escrita ou briefing material exige nova revisão e aceitação válida. Proposta expirada/dispensada não reaparece por retry. Uma nova mensagem humana revalida as propostas relacionadas. TTL padrão de sete dias para backlog e invalidação imediata por contexto incompatível; proposta não reavalia o repositório continuamente.

Tarefa já pedida explicitamente pode iniciar sem perguntar novamente, desde que a criação de nova sessão esteja autorizada. A origem registrada resolve a diferença. Mensagem de outro agente e passagem do tempo não contam como aceitação.

## A-01 — Timer é uma ocorrência persistida

Três operações de domínio, expostas pelo catálogo existente: esperar evento; agendar retomada única; criar/alterar rotina. Podem ter fachadas `wait_events`, `schedule_wakeup` e `schedule_task`; os nomes públicos finais passam pela revisão de compatibilidade. `schedule_wakeup` retoma o mesmo objetivo; rotina cria runs com lifetime definido. Nenhum pressupõe que a máquina continuará ligada.

```ts
interface ScheduledTrigger {
  scheduleId: string; revision: number;
  ownerSessionId: string; workItemId?: string;
  kind: 'once' | 'recurring';
  at?: string; cron?: string; timezone: string;
  action: { kind: 'notify' | 'resume' | 'run'; prompt?: string };
  authorizationRef: string; budgetId: string;
  expiresAt?: string;
  misfire: 'skip' | 'fire_once' | 'ask';
  overlap: 'skip' | 'coalesce';
  state: 'active' | 'paused' | 'expired' | 'cancelled';
}
interface ScheduledOccurrence {
  occurrenceId: string; scheduleId: string; revision: number;
  dueAt: string;
  state: 'due' | 'claimed' | 'accepted' | 'started' | 'finished'
    | 'missed' | 'failed' | 'cancelled' | 'outcome_unknown';
  claimEpoch?: number; leaseExpiresAt?: string; runId?: string;
}
```

Horário único deve ter offset; recorrência usa timezone IANA explícito. Validar futuro, expressão e próxima ocorrência. Guardar instante UTC e regra local; em mudança de DST, default proposto: hora inexistente é misfire, hora repetida dispara uma vez por slot local. Mostrar a interpretação ao usuário.

Chave de ocorrência: `(scheduleId, revision, dueAt)`. Claim com lease/fencing impede duas instâncias do host dispararem o mesmo slot. Revisão/conta/projeto fazem parte do ACK: resposta antiga não inicia trabalho em um estado novo.

Ordem: ocorrência persistida → claim → admissão idempotente do run → ACK → `started` → resultado. Não consumir one-shot antes da admissão confirmada. ACK ausente após possível despacho exige consulta pelo ID antes de retry. Registrar diferença entre aceito pela fila e realmente iniciado. One-shot manual antes do vencimento não consome automaticamente o slot futuro, salvo ação explícita de substituir.

## A-02 — Misfire, concorrência e recursos

- Defaults: once/notify `fire_once`; rotina `skip`; ação mutante incerta `ask`/reconciliação. Mostrar slots perdidos. Não executar dezenas de ocorrências acumuladas ao abrir o app.
- Se uma rotina já está ativa, `overlap=coalesce` acumula no máximo uma ocorrência pendente; `skip` registra a perda. Paralelismo por rotina fica fora do primeiro rollout.
- Sleep/offline/restart não significa que tarefas foram executadas. Recalcular ao retornar, preservando fuso e TTL. Não prometer execução com app/máquina desligado sem backend apropriado.
- Retry de admissão com backoff e teto; distinguir erro antes do run de falha de execução. Falhas repetidas estacionam e tornam a condição visível.
- Timers curtos para await interno não passam pelo modelo. Scheduler tem uma fila temporal compartilhada, não um processo por lembrete. Polling externo usa intervalo adaptativo e limite de duração/wakes.
- Para mudanças locais que já emitem evento, subscrever. Para serviço externo sem evento, polling autorizado com backoff. Nenhuma chamada LLM sem mudança relevante, salvo trabalho recorrente explicitamente solicitado.
- Cancelar/pausar uma rotina invalida claims ainda não iniciados. Run já iniciado recebe política explícita de continuar/parar; a UI distingue os dois atos.

## UX e observabilidade

O painel da sessão separa **Em execução**, **Esperando**, **Sugestões** e **Agendamentos**. Cada item mostra motivo, owner, estado real, última novidade e ação apropriada. Não emitir notificação a cada tick. Falha acionável, conclusão, necessidade de entrada ou mudança solicitada pelo usuário são sinais úteis.

Métricas: idade da mensagem até início, wakes úteis/sem novidade, duplo spawn evitado, propostas aceitas/dispensadas/stale, orçamento de sugestões, occurrences missed, ACK atrasado, recuperação após crash e tempo até parar. Logs são redigidos e usam referências; não duplicam transcripts ou credenciais de MCP/bancos.
