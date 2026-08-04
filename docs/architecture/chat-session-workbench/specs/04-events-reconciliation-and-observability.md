# 04 — Eventos, reconciliação e observabilidade

## 1. Objetivo

Unificar histórico, live state, badges, notificações e Worker Log num protocolo
session-scoped que sobreviva a reconnect, troca de sessão e restart.

## 2. Envelope canônico

```ts
interface SessionWorkbenchEvent {
  sessionId: SessionId;
  busId: string;
  seq: number;
  revision: number;
  occurredAt: string;
  type: SessionWorkbenchEventType;
  resource: SessionWorkbenchResource;
  data: TypedPayload;
}
```

- **CSW-EVT-001** — `type` e `data` formam union discriminada.
- **CSW-EVT-002** — `sessionId`, `busId`, `seq` e `revision` são obrigatórios
  para evento live.
- **CSW-EVT-003** — Eventos persistidos preservam identidade suficiente para
  deduplicação determinística.
- **CSW-EVT-004** — Timestamps de exibição vêm do servidor; tempo de recebimento
  pode ser registrado separadamente.

## 3. Resources e eventos mínimos

| Resource | Eventos |
|---|---|
| `summary` | goal, tasks/todos e process changed |
| `context` | drive, chapter, plan, file selection e skill selection changed |
| `execution` | run, operation, tool, subagent, warning e error |
| `insights` | telemetry/turn committed e tool stats invalidated |
| `canvas` | preview capability e diagram changed |
| `configuration` | skill/tool configuration changed |
| `navigator` | title, status, favorite, archive, group e unread changed |

Eventos podem carregar patch pequeno ou apenas `invalidates`; a escolha deve ser
determinística por tipo.

## 4. Reconciliação

Algoritmo obrigatório:

1. Bootstrap registra snapshot, revisions e cursor persistido.
2. Attach inicia com o maior cursor conhecido da sessão.
3. Evento com outro `sessionId` é rejeitado.
4. Novo `busId` reinicia high-water mark do bus, não a revision do resource.
5. `seq` repetido no mesmo bus é descartado.
6. Patch com revision menor ou igual à aplicada é descartado.
7. Evento que invalida resource agenda uma única revalidação coalescida.
8. Snapshot de refresh só substitui o resource se sua revision for igual ou
   maior à conhecida.
9. Gap de replay marca resource como `stale`, registra warning e refaz somente
   leituras necessárias.
10. Terminal event força flush antes de encerrar attach.

- **CSW-EVT-005** — Trocar de sessão nunca limpa state vivo de outra sessão.
- **CSW-EVT-006** — Reattach parcial preserva blocos anteriores ao cursor.
- **CSW-EVT-007** — Reconciliação não depende da ordem de renderização React.
- **CSW-EVT-008** — Um refetch atrasado nunca vence live revision mais nova.

## 5. Worker Log

O backend é a única autoridade de captura, sampling, categorização, redação e
truncamento.

- **CSW-LOG-001** — Renderer recebe eventos já normalizados.
- **CSW-LOG-002** — Deltas reconstruíveis de texto/thinking não entram por
  padrão no log diagnóstico.
- **CSW-LOG-003** — Progress repetido é sampled por operação no backend.
- **CSW-LOG-004** — Tail live e página histórica usam o mesmo schema.
- **CSW-LOG-005** — UI aberta depois do início da sessão consegue backfill.
- **CSW-LOG-006** — Busca e filtros extensos são server-side; filtro da página
  já carregada pode ser local.
- **CSW-LOG-007** — Buffer frontend é bounded e possui eviction por sessão.

## 6. Notificações

Notificação é uma projeção de evento, não um canal paralelo:

- source key estável;
- severidade;
- read/dismiss state;
- vínculo ao evento original;
- política de auto-dismiss apenas para banner.

- **CSW-NOT-001** — Badge unread e painel observam o mesmo resource.
- **CSW-NOT-002** — Reconnect não cria notificação duplicada.
- **CSW-NOT-003** — Abrir painel marca como lido por comando explícito.
- **CSW-NOT-004** — Dismiss de banner não apaga histórico.

## 7. Observabilidade do próprio workbench

Registrar, sem conteúdo sensível:

- duração do bootstrap;
- cache/ETag hit;
- tempo de abertura de panel chunk;
- eventos recebidos, deduplicados e rejeitados por revision;
- replay gaps;
- refetches por resource;
- tamanho dos buffers;
- renders dos selectors críticos;
- duração de query e bytes por endpoint.

Métricas não podem provocar escrita síncrona por evento no main process.

## 8. Falhas a testar

- cursor anterior ao buffer retido;
- bus substituído durante reconnect;
- evento terminal duplicado;
- snapshot antigo chegando depois de evento;
- troca A → B → A durante run;
- restart do backend com histórico persistido;
- evento maior que o limite;
- journal truncado/corrompido parcialmente;
- renderer em background com `requestAnimationFrame` suspenso.
