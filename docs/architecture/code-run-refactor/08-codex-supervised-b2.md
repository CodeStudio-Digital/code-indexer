# 08 — Codex B2 sob supervisor

> Documento histórico anterior à remoção do runtime Rust. Os caminhos e resultados descrevem o checkpoint da época; consulte o [estado atual](../runtime-retirement.md).

> **Status:** B2 físico completo; matriz 9/9 e soak limitado 100 + 5 aprovados
> **Data:** 2026-08-05
> **Branch:** `codex/oss-agent-bakeoff`
> **Baseline:** `7e79171d4c9a98397d3f47d9437d890e9316dc1d`
> **Sem cutover:** a seleção do runtime do produto não foi alterada

## 1. Resultado

O Codex app-server `0.146.0-alpha.9.2` executou dentro do Job Object da
attempt, chamou uma capability autorizada exatamente uma vez e encerrou com a
árvore integralmente reapada. A matriz adversarial passou nove cenários,
incluindo uma mutação descartável cujo efeito ocorreu antes da perda do
resultado: o Host escreveu o marcador uma vez, retornou `outcome_unknown` e o
TurnEngine não repetiu a operação.

O caminho mutante não usa uma feature ou ferramenta especial compilada no
runner. Ele atravessa a ponte genérica `HostCapability`, que é a fronteira
destinada a ToolHost, indexer, MCP e outros executores pertencentes ao Host.

Evidências machine-readable:

- [`results/codex-app-server-0.146.0-alpha.9.2-supervised-b2.json`](./results/codex-app-server-0.146.0-alpha.9.2-supervised-b2.json);
- [`results/codex-b2-physical-negative-matrix.json`](./results/codex-b2-physical-negative-matrix.json);
- [`results/codex-b2-bounded-soak.json`](./results/codex-b2-bounded-soak.json).

## 2. Composição física final

```text
Host TypeScript
  -> Control/Data IPC autenticado
    -> agentd-supervisor (owner do Windows Job Object)
      -> agent-runner verificado
        -> Codex app-server (child no mesmo Job)
          -> dynamic tool request
        <- ProviderToolCall normalizada pelo TurnEngine Rust
      -> CapabilityPrepare
    <- grant selado pelo Host
      -> CapabilityDispatchStarted autoritativo
      -> CapabilityExecute
    <- CapabilityExecutionResult + dedupe por operation
      -> CapabilityTerminal autoritativo
    <- lifecycle, journal e receipts duráveis
```

O executável, versão, schema, cwd e environment do Codex entram no
`ResolvedAttemptSpec` como snapshot selado. O `agent-runner` materializa o
snapshot e cria o child; o candidato não recebe store, registry ou callback de
produto.

Para `HostCapability`, o runner só pede execução depois do grant e do record
durável `CapabilityDispatchStarted`. O Host correlaciona attempt/runtime/
operation/tool/grant/input, executa no máximo uma vez durante a attempt e
reproduz o mesmo resultado em replay idêntico. Exceção do executor depois do
start vira `host_executor_result_ambiguous`; não existe retry automático.

## 3. Fronteiras aplicadas

- executable e cwd absolutos, candidate/protocol/schema pinados;
- versão validada contra `thread.cliVersion` do app-server;
- environment allowlist com `env_clear` no child;
- argv fixo; shell, browser, computer use, apps, plugins, multi-agent, image
  generation, hooks, skill search, tool suggestion e MCPs embutidos desligados;
- stdin/stdout JSONL bounded e stderr não herdado;
- uma attempt, um processo app-server e um thread temporário;
- catálogo imutável e alias conferido antes de preparar a capability;
- autorização e execução em duas fases distintas no canal Data autenticado;
- correlação de thread, turn, call, grant e digest de input;
- deadline, cancel, `kill_on_drop`, containment agregado e reap pelo supervisor.

## 4. Evidência do pacote final

| Campo | Resultado |
|---|---|
| versão Codex | `0.146.0-alpha.9.2` |
| SHA-256 do Codex | `ecd7a3eaff5e42723dbba03b5c91514b3986b5db5cbca8f34619620b5356f31f` |
| protocolo | `app-server-v2-experimental-tools` |
| digest do schema | `5a5b7e73f7f8f564ca829c2469de02aebf6b0027fe26e15d0a75669c3af43874` |
| pacote Rust | `runtime-v1-22cc347deaf4f440a11f27f602be21c0ae75ce13709ac56de6910fba1fec3bab` |
| manifest | `bf9998a1d8301ac16d82f49d798dfd524345ea7d5f59cc8d212c9a514721aa79` |
| processos no positivo final | 5 |
| journal no positivo final | 36 records |
| pico residente no positivo final | 152.829.952 bytes |
| containment | `hard_aggregate`, process tree owned |
| dispatches pendentes | 0 |
| tree empty após reap | sim |

Fatos físicos duráveis, em ordem: `launchAccepted`,
`attemptProcessSpawned`, `attemptContainmentReport`, `attemptProcessExited` e
`attemptProcessReaped`.

## 5. Matriz física adversarial

| Cenário | Prova |
|---|---|
| capability fora do snapshot | zero prepares; `provider_failed` |
| built-in proibido | zero prepares; `provider_failed` |
| resposta excessiva | nove deltas; `response_bytes_exceeded` |
| output acima do grant | `read_limit_exceeded`; zero pendências |
| initialize travado + cancel | reap dentro de 5 s |
| deadline imutável | reap automático sem cancel do Host |
| correlação divergente | falha lógica; pump físico retido até reap |
| transporte cai após read | um dispatch/terminal; nenhum retry |
| mutação + resultado perdido | marcador único; `outcome_unknown`; nenhum retry |

A mutação usa `flag: wx` em um workspace temporário selado. Uma repetição
falharia por arquivo existente e também seria detectada pelas contagens de
dispatch/terminal. O arquivo nunca toca dados reais e o fixture não entra no
pacote de produção.

## 6. Soak limitado

O gate final repetiu 100 turns determinísticos e cinco turns reais do Codex no
mesmo pacote:

| Série | Passes | Duração por attempt | Pico residente | Journal |
|---|---:|---:|---:|---:|
| fixture | 100/100 | 529–1.454 ms | 7.667.712–7.815.168 bytes | 7 |
| Codex real | 5/5 | 8.190–14.167 ms | 119.496.704–153.395.200 bytes | 36–51 |

Todas as iterações exigiram terminal autoritativo, zero dispatch pendente,
containment hard da árvore, reap físico e memória abaixo do grant de 512 MiB.
O fixture pode terminar antes da primeira amostra de heartbeat; por isso sua
contagem amostrada pode ser zero, embora containment e reap exatos sejam
assertados em cada iteração.

O pico histórico de 394.223.616 bytes não foi reproduzido. Ele permanece como
outlier real a observar no P3/canário, não como meta aprovada. Um warm-up antes
do gate final teve EOF transitório; o critério aceito é a sequência limpa
subsequente de 100 + 5.

## 7. Validação

- Rust workspace: 614 testes passaram, 14 ignorados;
- contratos + Host: 432 testes passaram, 17 pulados;
- Clippy `-D warnings`, rustfmt e typecheck: passaram;
- teto de 250 linhas: 782 módulos dentro do budget;
- fronteiras: 11 crates e 14 arestas internas;
- package verify e smoke: passaram;
- Windows positivo: 6/6;
- matriz física negativa: 9/9;
- soak: 100/100 fixture e 5/5 Codex real.

## 8. Limite da certificação

Status deste slice: `b2_physical_matrix_and_bounded_soak_passed`.

B2 prova a fronteira de engine, ToolHost genérico e supervisor. Não prova o
corpus P3 completo de filesystem/patch/git/process/http, MCP, skill, plugin,
subagente, Company, output spill e restart, nem torna estável a API experimental
de dynamic tools. Esses são gates explícitos de promoção, não falhas ocultas no
B2.
