# 02 — Ultra, runtime e qualidade

Os termos **DEVE**, **NÃO DEVE** e **PODE** são requisitos desta proposta. Valores numéricos identificados como defaults são decisões iniciais do CodeStudio, não resultados de benchmark do Claude.

## U-01 — Resolver uma política efetiva antes de agir

Evoluir `UltraPreset`/`PresetResolution` existentes. Ultra controla coordenação; provider/modelo, esforço, permissão, modo Explore/Plan e orçamento são dimensões independentes.

```ts
interface EffectiveAgentPolicy {
  schemaVersion: 2;
  revision: string;
  scope: 'turn' | 'session';
  source: 'user' | 'project' | 'session' | 'turn' | 'migration';
  orchestration: 'off' | 'manual' | 'adaptive';
  reasoning: {
    provider: string; model: string;
    requestedEffort?: string; effectiveEffort?: string;
    source: string; reasons: string[];
  };
  executionMode: 'explore' | 'plan' | 'implement';
  maxConcurrentAgents: number;
  maxAgentStarts: number;
  maxDepth: number;
  verification: 'minimal' | 'selective' | 'required';
  background: 'foreground_only' | 'allowed';
  isolation: 'shared_read' | 'exclusive_worktree';
  budgetId: string;
  authorizationRef: string;
}
```

Precedência: restrições obrigatórias de autorização/organização e capabilities limitam o resultado; dentro delas, override do turno > sessão > projeto > usuário > default. Uma preferência de nível inferior nunca amplia uma permissão. Pedido original e resultado efetivo ficam persistidos com motivos, inclusive downgrade de esforço, falta de isolamento e limite de paralelismo.

Ligar/desligar Ultra NÃO DEVE trocar provider, modelo ou esforço escolhido. A troca de provider/modelo reavalia capabilities e registra a nova revisão. A UI não pode manter “xhigh” se o adaptador envia “high”. Restrições comerciais do Claude não viram uma lista fixa de modelos permitidos do CodeStudio.

O prompt é derivado da mesma resolução usada pelo executor. Corrigir o `ultraCoordinationPrompt(3)` constante: com limite efetivo 1, prompt e UI devem dizer 1. Um campo declarado como durável ou obrigatório precisa de enforcement verificável; até lá, deve aparecer como indisponível/degradado, não como garantia.

## U-02 — Decidir quando coordenar

Ultra habilita uma decisão adaptativa para trabalho substantivo. Não exige fan-out de toda mensagem. A decisão usa escopo, dependências, conflitos de escrita, evidência faltante e orçamento; não apenas tamanho do prompt ou uma palavra-chave.

```ts
interface CoordinationDecision {
  strategy: 'solo' | 'delegate' | 'workflow' | 'linked_chats';
  reason: string;
  independentUnits: number;
  expectedBenefit: 'context' | 'latency' | 'confidence' | 'none';
  verificationPlanId: string;
  stopCriteria: string[];
  policyRevision: string;
}
```

| Estratégia | Uso | Evitar |
|---|---|---|
| Solo | Pergunta, edição pequena, empacotamento, trabalho sequencial | Criar agentes só porque Ultra está ligado |
| Delegação | Uma investigação independente ou verificação específica | Repetir a mesma busca no pai e no filho |
| Workflow | Dependências e resultados intermediários explícitos | Espelhar outra task list/workflow em execução |
| Chats vinculados | Colaboração duradoura entre sessões com donos distintos | Criar chats permanentes para todo subpasso efêmero |

Default inicial conserva até 3 filhos concorrentes e profundidade 1. O teto de inícios deve refletir os limites existentes e o orçamento da tarefa; começar com 24, configurável, sem prometer que 24 agentes sejam necessários. Esses tetos são backstops, não metas. O usuário pode reduzir a escala e interromper o trabalho a qualquer momento.

## U-03 — Um plano versionado sobre o DAG existente

Evoluir `tools/workflow/*`, `runSubagent` e o BT. Não criar uma segunda família de agentes para Ultra. O novo plano acrescenta contratos ao DAG atual de até 12 passos. Esse limite permanece no primeiro rollout; ampliar somente se o corpus mostrar necessidade.

```ts
interface PlanStep {
  stepId: string;
  revision: number;
  kind: 'investigate' | 'implement' | 'verify' | 'integrate' | 'synthesize';
  dependsOn: string[];
  inputRefs: string[];
  outputSchemaRef?: string;
  acceptance: string[];
  readPaths: string[];
  writePaths: string[];
  policyRevision: string;
  retry: { maxAttempts: number; replay: 'read_only' | 'idempotent' | 'reconcile' };
}
```

O dispatcher valida IDs, ciclos, dependências, capacidade do perfil, escopo de escrita e orçamento antes de lançar. Prompt não substitui essa validação. Escritores concorrentes precisam de worktree/ownership compatíveis; leitores podem compartilhar estado identificado por revisão. Incompatibilidade entre snapshot e árvore atual torna o resultado stale e exige revisão antes de integrar.

O scheduler DEVE liberar um passo assim que **suas** dependências forem aceitas. Hoje há barreira entre ondas: um leitor lento bloqueia verificações que já poderiam começar. Exemplo: A→VA e B→VB; quando A termina, VA pode iniciar sem aguardar B. Uma etapa de integração que depende de VA+VB continua sendo uma barreira legítima.

Extensão dinâmica é uma nova revisão do plano, validada e persistida antes do despacho. Pode acrescentar passos pendentes e ramificações por resultado; não pode reescrever a identidade de um passo já executado. Redução/alteração de escopo cancela ou invalida os dependentes explicitamente.

Não adicionar execução arbitrária de scripts só para reproduzir a API JavaScript do Claude. Map/reduce e pipelines podem ser representados como passos expandidos e dependências no contrato existente. Um frontend de scripts determinísticos fica para uma ADR posterior, se os casos reais não couberem no DAG e no `code_exec` supervisionado.

## U-04 — Resultado tipado e aceitação

```ts
interface AgentWorkResult {
  version: 1;
  runId: string; stepId: string; attemptId: string;
  status: 'succeeded' | 'partial' | 'failed' | 'cancelled' | 'needs_input';
  summary: string;
  artifacts: { ref: string; digest: string; kind: string }[];
  findings: {
    claim: string;
    evidenceRefs: string[];
    verdict: 'confirmed' | 'refuted' | 'unverified';
  }[];
  acceptance: { criterion: string; passed: boolean; evidenceRefs: string[] }[];
  unresolved: string[];
  effectOutcome: 'none' | 'known' | 'unknown';
  usageRef: string;
}
```

Texto final do filho é apresentação; o coordenador não deve inferir sucesso de palavras como “concluído”. Schema inválido recebe reparo limitado, com erro explícito após esgotar tentativas. `partial` não satisfaz uma dependência por padrão; o consumidor pode aceitar explicitamente um subconjunto com evidências. Falha da API/verificador deixa a alegação `unverified`, nunca `refuted` ou `confirmed`.

A síntese recebe resumos limitados e referências recuperáveis, sem despejar todos os transcripts no contexto. Preservar `runId`, perfil, modelo efetivo e origem da evidência. Dois agentes que repetem a mesma afirmação sem provas independentes não constituem confirmação.

## U-05 — Verificação proporcional e critério de parada

A qualidade deve incluir correção **e** adequação ao pedido. Definir o plano de verificação antes de expandir agentes. Ele pode mudar por falha ou nova descoberta, registrando a razão.

| Classe | Plano padrão | Condição de encerramento |
|---|---|---|
| Informação/documentação | Fontes relevantes, consistência e links | Perguntas cobertas; incertezas declaradas |
| Mudança local pequena | Check focal necessário ao comportamento | Check passou e não há risco específico aberto |
| Build/instalador | Pipeline da build e integridade mínima do artefato | Arquivo válido entregue; homologação só quando parte do pedido |
| Mudança transversal | Contratos afetados, teste focal e jornada relevante | Requisitos aceitos, integração coerente |
| Efeito irreversível/compartilhado | Evidência e autorização correspondentes | Resultado conhecido ou estado incerto claramente entregue |

O sistema NÃO DEVE executar revisão adversarial, suíte completa ou teste de UI por ritual em toda tarefa. Repetir um teste sem mudança de entradas exige uma causa registrada: flakiness em investigação, falha intermitente ou nova evidência. Nenhum verificador pode inventar nova obrigação fora do escopo e bloquear entrega silenciosamente.

Quando a tarefa termina, produzir `deliverable.ready` com evidências suficientes e encerrar. Melhorias opcionais viram propostas separadas. “Faça só o instalador”, “pare de testar” e instruções equivalentes alteram o plano imediatamente: parar verificações extras, preservar o artefato e encerrar processos próprios de forma controlada.

Critérios universais: entregável existe; requisitos obrigatórios foram aceitos ou estão explicitamente pendentes; efeitos desconhecidos não foram ocultados; não há filho obrigatório esquecido; uso/limites registrados; não há trabalho opcional impedindo a entrega.

## U-06 — Budget agregado e reserva

Substituir o contador exclusivamente em memória por ledger persistido ligado a `budgetId`. Conservar o semáforo leve para concorrência, mas ele deixa de ser a fonte do saldo.

Unidades separadas: tokens de entrada/saída/cache quando fornecidos, gasto monetário conhecido, tempo ativo, inícios de agentes, chamadas de ferramentas e wakeups automáticos. Preço desconhecido não equivale a zero. Não converter contagem de agentes em custo real.

Antes do despacho, reservar capacidade e, quando disponível, estimativa conservadora de tokens/custo. Ao terminar, liquidar uso observado e liberar a reserva. A soma inclui coordenador, filhos, workflows, verificadores, sugestões geradas por modelo e retomadas automáticas. Paralelismo não pode ultrapassar o saldo por conferir o mesmo valor simultaneamente.

Orçamento humano explícito é teto duro. Sem teto monetário informado, aplicar limites operacionais configurados, sem inventar permissão para gasto ilimitado. Ao atingir limite, persistir estado, impedir novos despachos e apresentar progresso recuperável. Limite do provider pode gerar `waiting_capacity` com horário conhecido; não iniciar loop de retries ou trocar modelo caro silenciosamente.

## U-07 — Checkpoint e retomada

Evoluir checkpoints do workflow e dos filhos para uma identidade comum: `sessionId`, `runId`, `stepId`, `attemptId`, `epoch`, `ownerInstanceId`, `leaseExpiresAt`, referências dos inputs/outputs, política solicitada/efetiva, saldo/reservas, estado de efeitos e posição do journal.

PID é diagnóstico, não prova suficiente de ownership. Retomada requer lease válido/reclamado com fencing, pois o SO reutiliza PIDs. A configuração original é preservada como intenção; a autorização **atual** é reavaliada. Revogação de acesso reduz capacidades. Provider/profile ausente resulta em `needs_input` ou fallback permitido registrado, nunca escolha silenciosa.

Algoritmo de recovery:

1. Adquirir lease com epoch novo e carregar journal/checkpoint compatíveis.
2. Reconciliar tentativas cujo executor possa continuar ativo; não lançar concorrente duplicado.
3. Reutilizar resultados aceitos se inputs, política relevante e revisão do workspace forem compatíveis.
4. Reexecutar leitura segura ou efeito comprovadamente idempotente conforme política de retry.
5. Marcar mutação sem confirmação como `effectOutcome=unknown`; bloquear seus dependentes até reconciliação.
6. Reconstituir esperas/timers autorizados e projeções de UI; a ausência de transcript não autoriza reiniciar tudo.

Registro terminal acontece **depois** do resultado persistido. Uma falha de persistência impede anunciar conclusão durável. O log diagnóstico amostrado/SSE não é journal de recovery. Evoluir as APIs de armazenamento de sessão, com escrita atômica, fencing e versão; não migrar conversas para SQLite.

## U-08 — Pausa, cancelamento e intervenção

Separar pausar novos despachos, cancelar uma espera, cancelar um run e interromper efeitos de ferramenta. `cancel_requested` não é `cancelled`; só marcar terminal depois do acknowledgement/saída conhecido. Cancelar um wait não encerra a tarefa observada.

Pausa/stop humano ganha das retomadas automáticas. Registrar epoch/geração de cancelamento; mensagem/timer antigo não pode ressuscitar run parado. Cancelar a raiz propaga aos filhos pertencentes àquele run, sem interromper sessões independentes ou processos do usuário. Worktrees e outputs são preservados enquanto necessários à revisão.

A UI mostra quem está trabalhando, esperando, limitado ou precisando de entrada; motivo do bloqueio; próxima condição de retomada; gasto conhecido; e controle de parar. Mostrar estes estados não exige despejar detalhes internos do executor no fluxo normal.
