# 11 — P3 local: ToolRegistry atrás de HostCapability

> Documento histórico anterior à remoção do runtime Rust. Os caminhos e resultados descrevem o checkpoint da época; consulte o [estado atual](../runtime-retirement.md).

> **Snapshot:** 2026-08-05
> **Estado:** bridge de código e corpus local aprovados; gate P3 físico pendente
> **Runtime ativo:** inalterado

## Resultado

O Host agora possui um ponto de composição explícito que liga o
`capabilityGatewayFactory` do runtime Rust ao mesmo `ToolRegistry` selado usado
pelo produto. Não foi criada uma segunda pilha para tools nativas, indexer,
MCP, plugins, skills, subagentes ou Company.

`createToolRegistryCapabilityGatewayFactory` compõe, por attempt:

1. identidade física do canal;
2. SHA-256 exato do `ResolvedCapabilitySet`;
3. firewall de membership/version/mutation/execution class;
4. autoridade de policy/approval obrigatoriamente fornecida pelo produto;
5. `CapabilityGateway` com dedupe por operation;
6. `ToolRegistryHostCapabilityExecutor` com fence, deadline/cancel e output
   bounded.

A factory rejeita identidade ou capability-set divergentes antes de consultar
policy. Ela não fabrica uma decisão `allow`. O executor só recebe grants já
selados pela autoridade e ainda revalida snapshot, versão, mutação, classe e
fence antes de chamar o handler.

## Por que não foi ligado diretamente ao runCoder legado

No executor TypeScript atual, policy shadow, approval, task-mode e guards rodam
antes de `registry.invoke`. Chamar o adapter novo diretamente de `runCoder`
criaria um atalho ao redor desses controles. O P3 usa uma factory de gateway
com autoridade obrigatória; o cutover só poderá fornecer essa autoridade pelo
Host, depois do gate físico. O legado continua como oracle e fallback, não como
uma nova camada permanente.

## Contrato de resultado

O wire result é `codestudio.tool-result.v1`:

- preserva `content`, `isError`, formato e erro estruturado;
- registra `originalBytes`, `truncated` e `outputId` para refetch;
- executa `commitResult` antes de limitar o wire, preservando `subUsage`,
  `extraUserBlocks` e o resultado integral para accounting/persistência;
- falha fechado se o envelope exceder 1 MiB;
- Rust desempacota o conteúdo sem transformar erro de tool em sucesso e
  rejeita divergência entre o envelope e a telemetria de truncation.

## Corpus local executável

Arquivo principal:
`packages/code-agent/src/runtime/__tests__/tool-registry-host-capability-executor.test.ts`.

| Área | Evidência local |
|---|---|
| filesystem | `read_file` e `create_file` reais em diretório temporário |
| shell/process | `run_command` real, processo encerrado e output retornado pelo Host |
| HTTP | servidor localhost real, request bounded e network fence |
| gateway | prepare/execute, replay da mesma mutação e um único efeito físico |
| snapshot | digest estrangeiro rejeitado antes da autoridade; registry tardio rejeitado |
| policy | `deny` e `approval_required` retornam antes de qualquer handler |
| fence | mutação sem fence falha antes de criar arquivo |
| MCP/indexer | handler `mcp_internal` passa pelo mesmo executor e schema |
| plugin | provenance externo e erro estruturado preservados |
| skill | search/activate catalog-only; ativação não concede tool ausente |
| subagente/Company | usage e blocos de lifecycle chegam ao commit durável antes do cap |
| output grande | spill para output store e envelope abaixo de 4 KiB no fixture |
| deadline/cancel | read termina cancelled; possível efeito termina outcome_unknown |
| input hostil | UTF-8/JSON/prototype/complexidade e capability estrangeira falham fechado |

Os testes de `agent-runner` também cobrem o decoder Rust do novo result schema,
inclusive erro de tool e conflito de truncation.

## O que este slice não autoriza

O P3 local não é o gate P3 completo e não promove runtime. Ainda faltam:

1. MCP e plugin externos físicos, com discovery/call/reconnect;
2. subagente e Company completos, com budgets, cancel e lifecycle persistido;
3. restart/recovery depois de `DispatchStarted`, sem repetir mutação;
4. comparação shadow com model/policy/budgets equivalentes;
5. execução no build instalado, métricas, canário por attempt e rollback real.

Até essas provas, o roteamento default permanece no runtime atual e nenhuma
sessão ativa deve ser reiniciada para carregar esta worktree.
