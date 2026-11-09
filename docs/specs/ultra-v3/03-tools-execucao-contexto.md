# 03 — Tools, execução e contexto

Este capítulo estende os contratos de [descoberta/MCP](../agent-ide-reliability/03-descoberta-e-mcp.md), [execução](../agent-ide-reliability/04-execucao.md) e [resultados](../agent-ide-reliability/06-contratos-e-observabilidade.md). Não autoriza criar implementações paralelas dessas capacidades.

## T-01 — Uma descoberta coerente para pai e filhos

Manter `find_tools` e `expand_toolset` como fachadas compatíveis do snapshot canônico de capabilities. O agente deve poder localizar uma capacidade por nome exato ou intenção, ativar somente o necessário e receber confirmação da projeção efetiva. A inspiração é o fluxo lexical/seletivo do CLI, não uma exigência de embeddings para descoberta. Evidência C07.

```ts
interface DiscoveryReceipt {
  catalogRevision: string;
  policyRevision: string;
  projectionRevision: string;
  matches: {
    capabilityId: string;
    schemaDigest: string;
    state: 'already_available' | 'activated' | 'pending_provider'
      | 'deferred_budget' | 'unavailable' | 'denied';
    reason?: string;
    callableVia: ('provider' | 'code_exec')[];
    availableFromAttempt?: string;
  }[];
  nextCursor?: string;
  coverage: 'complete' | 'partial';
}
```

Requisitos:

1. Nome exato usa índice direto e seleção determinística. Busca por conceito usa aliases PT/EN e ranking mensurado; não procura semântica antes de conferir o nome conhecido.
2. Descoberta não concede autorização. O dispatcher continua sendo a autoridade inclusive para chamada aninhada em `code_exec`.
3. `activated` para provider só aparece quando o schema consta na projeção final, ou indica explicitamente o próximo attempt. Não basta acrescentar tier a um Set.
4. `pending_provider` não é ausência. Uma conexão MCP em andamento ou erro de conexão fica visível e não dispara reconexões duplicadas por cada filho.
5. Cache inclui revisão do catálogo, schema, política e capabilities do provider. Mesmo nome com schema novo invalida cache. Não copiar a chave apenas por nomes observada no recorte Claude.
6. Busca, paginação e expansão respeitam limites de CPU, payload, quantidade e orçamento de schema. Entrada enorme não bloqueia o host.
7. O filho recebe acesso ao catálogo autorizado e um pequeno working set apropriado ao papel. Não herda indiscriminadamente todos os schemas/transcripts do pai.
8. Resultado vazio inclui cobertura/motivo; nomes internos de ferramentas proibidas não precisam ser revelados a quem não pode descobri-los.

A superfície ideal para o modelo tem uma intenção principal (“encontre/ative esta capacidade”); a compatibilidade legada resolve tiers internamente. Métricas: primeira seleção correta, chamadas para recuperar um erro, schemas efetivamente carregados, custo de discovery e taxa de ausência falsa.

## T-02 — Invocação única, várias formas de acompanhar

Toda operação possui `invocationId` estável, tentativa, owner, política e lifetime. Devolver controle ao chat ou mandar uma chamada MCP para background não cria outra operação. O exemplo estático do CLI mantém a chamada original e publica conclusão depois; não garante que o processo sobreviva ao encerramento do host. Evidência C08.

```ts
interface TaskExecutionView {
  taskId: string;
  invocationId: string;
  attemptId: string;
  ownerRunId: string;
  executionState: 'queued' | 'running' | 'waiting_input' | 'cancel_requested'
    | 'succeeded' | 'failed' | 'cancelled' | 'lost';
  effectOutcome: 'none' | 'known' | 'unknown';
  lifetime: 'turn' | 'run' | 'session' | 'host';
  exitCode?: number;
  outputRef?: string;
  nextCursor?: string;
  truncated: boolean;
}
```

Há três relógios diferentes: deadline da operação, tempo máximo da espera de quem chamou e prazo de retenção do resultado. Um timeout de espera não cancela a execução. Uma mensagem humana pode fazer a UI/runner devolver controle enquanto a operação continua; elicitação/aprovação pendente vira `waiting_input`, com destino claro.

Conclusão é persistida uma vez por tentativa e entregue com dedup por evento. O transporte pode repetir; o consumidor aplica idempotência. Nunca prometer entrega exatamente uma vez em todos os sistemas externos. Retry só é automático para leitura, erro conhecido anterior ao efeito ou idempotência comprovada.

## T-03 — Execução de código e shell

Reutilizar supervisor `code-exec`, `CommandSpec`, spool/paginação e process-tree ownership da spec de reliability. O novo Ultra apenas fornece escopo, orçamento e vínculo com o passo. Não criar um executor “especial Ultra” que contorne essas regras.

- Registry, schema e autorização são os mesmos para tool direta, chamada aninhada e filho. Classificar efeitos pela operação real; a tool de orquestração não pode ser tratada como leitura só por retornar texto.
- `code_exec` deve compor chamadas independentes e transformar resultados estruturados. Não deve esconder loops infinitos, mutações repetidas ou concatenação insegura de shell.
- Batch de leituras independentes pode ser paralelo; dependências, mutações sobre o mesmo recurso e integrações precisam de ordem/fence explícitos.
- Saída tem referência, cursor, bytes totais e truncamento; uma cauda não se apresenta como log completo. UTF-8, ownership e expiração seguem os contratos existentes.
- Cancelar por nome requer resolução não ambígua; o ato final usa ID/owner/epoch. Cancelar não equivale a rollback. Processo perdido após crash fica `lost`, com efeito separado.
- Agente implementador isolado atualmente não recebe shell/code_exec/MCP externo. Manter essa restrição na primeira fase; usar verificador autorizado ou coordenador. Um perfil futuro de verificação no worktree exige confinement real, sem ampliar todos os implementadores por conveniência.

## T-04 — Contexto necessário e suficiente

Criar `DelegationContext` versionado com: objetivo; critério de pronto; exclusões; arquivos/artefatos relevantes; revisões; decisões do usuário; política efetiva; descobertas já feitas; dependências; resultado esperado. O coordenador deve especificar a pergunta independente que o filho responde.

| Camada | Conteúdo | Regra |
|---|---|---|
| Estável | Regras do projeto, capacidades e identidade do papel | Reutilizar; ordem determinística; sem duplicar em cada mensagem |
| Tarefa | Objetivo, escopo e aceitação | Preservar em compactação e retomada |
| Evidência | Arquivos, resultados de busca, outputs com revisão | Recuperação seletiva e indicação de staleness |
| Coordenação | Pendências, mensagens, donos e próximos eventos | Estado estruturado persistido; não apenas prosa |
| Histórico detalhado | Transcript completo | Sob demanda; não transportar automaticamente para todo filho |

O índice e repo-map ajudam a localizar contexto; a leitura relevante confirma o estado atual. Se uma busca está parcial/stale, o agente não pode concluir “não existe”. A avaliação de qualidade deve rastrear a cadeia busca → arquivo lido → decisão, consumindo a evidência da spec anterior.

Compactação preserva autorização humana, objetivos, decisões, IDs de operações incertas, artefatos, próximos passos e esperas. Não compactar incerteza como sucesso. Child result com revisão antiga permanece referência histórica até revalidação.

O cache é uma otimização do provider. Prefixos estáveis, schemas seletivos e resumos são transferíveis. “Acordar em 270 segundos” não é regra universal: TTL, modalidade de cobrança e economia esperada são capabilities/dados do provider. Não gerar turnos vazios para manter cache aquecido.

## T-05 — Qualidade dos perfis

Perfis devem alterar ferramentas, escopo e formato de entrega, além do prompt. `investigate` produz mapa com referências; `implement` produz artefato/diff e registra o que conseguiu verificar; `verify` testa alegações específicas; `integrate` resolve compatibilidade entre alterações; `synthesize` compara evidências e pendências.

Modelo e esforço seguem a configuração efetiva. Roteamento por custo/perfil é uma política explícita, opcional e auditável; não presumir que modelo diferente seja superior ou que todo verificador precise do maior esforço. Comparar estratégias com o mesmo provider/modelo primeiro, para não atribuir ao runtime ganhos do modelo.

O prompt deve orientar: fazer o que foi pedido, reutilizar descobertas, retornar dados/evidências, pedir ajuda somente para lacuna real e parar ao satisfazer a aceitação. Evitar prompts longos que simultaneamente ordenem “sempre delegue”, “sempre revise”, “nunca pare” e “seja rápido”. O estado/limite vem do host; texto explica o contrato.

## T-06 — Database e integrações

Não redesenhar drivers nesta SPEC. Consultas de banco entram como invocações com cancelamento, resultado limitado e escopo de conexão conforme a spec anterior. Agentes paralelos não multiplicam pool, deadline ou orçamento por criarem contextos novos. Cache de schema/resultados respeita conexão, usuário, revisão e permissões.

Resultados parciais ou truncados não autorizam conclusão global. Efeitos mutantes incertos não são repetidos por um verificador ou agente novo. Uma tarefa adicional que precise de outra conexão, conta ou destino deve passar pela autorização correspondente, mesmo que tenha sido sugerida por um agente autorizado no projeto.
