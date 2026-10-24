# 07 — Resultados do bake-off de motores OSS

> Documento histórico anterior à remoção do runtime Rust. Os caminhos e resultados descrevem o checkpoint da época; consulte o [estado atual](../runtime-retirement.md).

> **Data:** 2026-08-05
> **Worktree:** `D:\MCP-worktrees\oss-agent-bakeoff`
> **Branch:** `codex/oss-agent-bakeoff`
> **Baseline:** `7e79171d4c9a98397d3f47d9437d890e9316dc1d`
> **Decisão:** continuar por adapters; não criar fork nem fazer cutover

## 1. Resumo executivo

O spike confirma que podemos experimentar um motor OSS sem entregar a ele a
autoridade do CodeStudio. O primeiro slice implementou o contrato neutro, um
peer JSON-RPC bounded e o adapter do Codex app-server. O segundo portou esse
adapter para o `agent-runner`: o processo real agora herda o Job Object da
attempt, usa o TurnEngine Rust e chama uma tool read-only do Host exatamente
uma vez pelo canal Data autenticado.

O B2 físico está completo: positivo real, matriz adversarial 9/9, mutação real
descartável sob ACK ambíguo e soak limitado de 100 turns determinísticos mais
cinco turns reais. A mutação atravessa a ponte genérica `HostCapability`, cria o
efeito uma vez e terminaliza `outcome_unknown` sem retry. Isso ainda NÃO
certifica o Codex para produção: dynamic tools são experimentais e o corpus
B3/P3 continua pendente. O run direto anterior permanece corretamente rejeitado.

O Goose permanece candidato, mas por uma fronteira diferente: ACP para
lifecycle e um MCP efêmero, autenticado e limitado à attempt para projetar o
ToolHost. Não há justificativa técnica para fork de nenhum dos dois candidatos
nesta fase.

## 2. Slice implementado

O pacote `@mcp/agent-runtime-host` agora contém, apenas nesta branch:

- contrato imutável de candidato, attempt, capabilities, receipt e eventos;
- validação de cwd absoluto, IDs/aliases únicos e digest SHA-256 do protocolo;
- budgets de 32 capabilities, 12 KiB de schemas e 64 KiB por resultado;
- aliases determinísticos que não expõem IDs internos ao modelo;
- transporte JSONL e peer JSON-RPC com limites de bytes, requests pendentes e
  requests concorrentes iniciadas pelo servidor;
- adapter Codex com sandbox read-only, approval `never`, correlação estrita de
  thread/turn/call e deny fail-closed para requests não autorizados;
- execução de dynamic tool exclusivamente pelo port do ToolHost;
- detecção de command/file/MCP/web/collaboration executados fora do ToolHost;
- interrupt, deadline, deleção de thread temporário e relatório de
  certificação separado do resultado funcional.

O script `scripts/run-codex-app-server-bakeoff.ts` é um harness de evidência,
não um launcher de produção. Ele exige caminho absoluto, versão e digest do
schema; desabilita as features embutidas relevantes e remove MCPs configurados
antes de iniciar o processo.

## 3. Codex app-server — run direto histórico

### Identidade e schema

| Campo | Evidência |
|---|---|
| distribuição | `@openai/codex@0.146.0-win32-x64` |
| versão reportada | `codex-cli 0.146.0` |
| protocolo | `app-server-v2-experimental-tools` |
| arquivos do schema gerado | 349 |
| bytes do bundle de schema | 3.343.741 |
| digest determinístico do manifest | `5a5b7e73f7f8f564ca829c2469de02aebf6b0027fe26e15d0a75669c3af43874` |

O digest acima é do manifest ordenado dos arquivos gerados, não de um único
arquivo. Ele vincula a attempt ao snapshot completo usado na validação.

### Drift detectado

O primeiro processo real rejeitou `thread/start` porque o enum de sandbox no
wire é `read-only`, embora `turn/start.sandboxPolicy.type` use `readOnly`.
O teste sintético anterior não capturava essa assimetria. O adapter foi
corrigido e o teste passou a afirmar as duas representações diferentes. Esse é
um exemplo concreto de por que versão e schema precisam ser pinados.

### Run real aceito pelo adapter

O output machine-readable está em
[`results/codex-app-server-0.146.0-run.json`](./results/codex-app-server-0.146.0-run.json).

| Métrica | Resultado |
|---|---:|
| attempt | `14ab3239-7036-4dd5-8a5a-6434b6e3b9b0` |
| thread | `019fce68-61f5-7e83-9648-ec4eec72d784` |
| turn | `019fce68-6340-7492-8a1f-f6b2c17862ac` |
| status do turn | `completed` |
| initialize | 114 ms |
| thread start | 338 ms |
| turn start | 1 ms |
| primeiro delta | 8.564 ms |
| total | 9.775 ms |
| capabilities projetadas | 1 |
| chamadas recebidas pelo ToolHost | 1 |
| requests embutidos negados | 0 |
| execuções fora do ToolHost observadas | 0 |
| thread temporário removido | sim |
| processo filho | saiu com código 0 |

A autenticação existente foi usada somente para a chamada do modelo. A tool
retornou um resultado sintético do índice; não houve escrita no workspace.

### Gate de produção

Resultado: `rejected`, por:

1. `durable_supervisor_ownership_not_proven` — o processo não nasceu pelo
   port autenticado do `agentd-supervisor`;
2. `process_tree_not_reaped` — o harness direto não é o supervisor Windows com
   Job Object;
3. `resource_limits_not_enforced` — o harness não aplica grants externos.

Observação não eliminatória: `dynamic_tool_api_is_experimental`.

Portanto, esse run prova compatibilidade do adapter e autoridade da tool no
caso testado. Ele não prova isolamento de processo, limites, cancelamento sob
carga, idempotência de mutação nem qualidade no corpus P3.

### Gate físico B2 positivo

O port Rust posterior executou o app-server que reporta
`0.146.0-alpha.9.2` dentro do `agentd-supervisor`. O output machine-readable
está em
[`results/codex-app-server-0.146.0-alpha.9.2-supervised-b2.json`](./results/codex-app-server-0.146.0-alpha.9.2-supervised-b2.json),
e a composição é detalhada em
[`08-codex-supervised-b2.md`](./08-codex-supervised-b2.md).

Resultado final: `b2_physical_matrix_and_bounded_soak_passed`. Cinco processos
estavam contidos no Job no positivo final; uma capability foi preparada pelo
Host, nenhum dispatch ficou sem resolução, o pico residente foi 152.829.952
bytes e o supervisor confirmou `attemptProcessExited` seguido de
`attemptProcessReaped`.

A matriz adversarial executou nove cenários físicos: capability desconhecida,
built-in proibido, resposta acumulada excessiva, output de tool acima do grant,
cancel durante initialize, deadline imutável, correlação divergente e queda do
transporte após o resultado da tool, além de uma mutação cujo resultado se
perde depois do efeito. Todos reapearam a árvore. Na mutação, o Host escreveu o
marcador exatamente uma vez, retornou
`host_executor_result_ambiguous`/`outcome_unknown` e não houve retry.

O soak final no mesmo pacote passou 100/100 turns do fixture e 5/5 do Codex
real. O pico real ficou entre 119.496.704 e 153.395.200 bytes, abaixo do grant
de 512 MiB. O outlier histórico de 394.223.616 bytes não foi reproduzido e
continua registrado como observação para P3/canário. Detalhes:
[`results/codex-b2-bounded-soak.json`](./results/codex-b2-bounded-soak.json).

## 4. Goose — qualificação de protocolo

### Snapshot analisado

O resumo machine-readable está em
[`results/goose-acp-source-audit.json`](./results/goose-acp-source-audit.json).

| Campo | Evidência |
|---|---|
| repositório | `block/goose` / `aaif-goose/goose` |
| commit | `b4dd5fb5875878943724cba4468313f6038afd2b` |
| protocolo | Agent Client Protocol (ACP) sobre stdio |
| schema Goose gerado | 249.297 bytes |
| SHA-256 do schema | `a11855b3e3335b422ed36602abc4db70a89df3c590c767eedc36e5dafcdb7681` |

### O que o source confirma

- o servidor ACP possui `initialize`, `session/new`, `session/prompt`,
  `session/cancel`, `session/close` e a extensão `session/delete`;
- o launcher ACP recebe a lista de built-ins explicitamente, portanto pode ser
  iniciado sem built-ins;
- quando `session/new` recebe `mcpServers` não vazio e nenhuma recipe/extension
  Goose, usa essa lista em vez das extensions/MCPs configuradas localmente;
- filesystem e terminal do cliente são capabilities negociadas; o adapter não
  deve anunciá-las;
- cancel possui token por prompt ativo;
- `session/delete` remove o registro persistido, a sessão em memória e o agent
  carregado.

### Fronteira correta

O Goose não oferece o equivalente direto às dynamic tools do Codex. O próximo
slice deve criar um MCP HTTP/stdio efêmero por attempt:

```text
Goose ACP process
  -> attempt-scoped MCP endpoint
    -> capability alias validation
      -> ToolHost
```

Esse MCP precisa exigir token opaco de curta duração, expor somente o snapshot
da attempt, propagar cancel/deadline, validar receipts e encerrar antes do
process reap. Passar `mcpServers: []` seria incorreto: o Goose então carrega
extensions configuradas localmente e perde o isolamento do catálogo.

Status provisório do Goose: `protocol_qualified_for_b0`; B1 não foi executado.
A lacuna é do nosso harness MCP/supervisor, não um defeito atribuído ao Goose.

## 5. Matriz de decisão provisória

| Gate | Codex | Goose |
|---|---|---|
| protocolo session-scoped | comprovado em processo real | comprovado no source |
| catálogo imutável por attempt | dynamic tools no adapter | requer MCP efêmero |
| built-ins isoláveis | sim no run observado | sim pelo launcher + ACP |
| deleção de estado efêmero | comprovada | suportada no source |
| cancel | cancel/deadline e soak limitado passaram | suportado no source, não executado |
| supervisor/resource grants | B2 positivo/negativo/mutante comprovado | pendente |
| API de tools estável | não; experimental | MCP/ACP, falta run pinado |
| B2/B3 | B2 físico completo; B3 pendente | pendente |

Conclusão: o Codex segue como adapter versionado e substituível para B3/P3,
sem fork e sem cutover. Goose segue em paralelo conceitual somente após existir
a fachada MCP efêmera; não se deve implementar duas versões da mesma ponte
ToolHost. A decisão está em
[`09-oss-engine-decision.md`](./09-oss-engine-decision.md).

## 6. Próximos gates executáveis

1. implementar uma única fachada MCP attempt-scoped reutilizável por Goose e
   por servidores MCP externos;
2. ligar os executores reais de ToolHost/indexer/MCP à ponte `HostCapability`;
3. rodar Goose B1 com data/config dirs temporários e nenhum built-in;
4. executar o corpus P3 com mesmos modelo, esforço, policy e budgets;
5. reavaliar a classificação do adapter e o risco de `dynamicTools` após B3.

## 7. Validação local

- Rust workspace: 614 testes passaram, 14 ignorados, nenhuma falha;
- contratos + Host: 432 testes passaram, 17 pulados;
- Clippy `-D warnings`, rustfmt, typecheck do Host, LOC e crate boundaries:
  passaram;
- pacote Rust final: build, verificação pelo Host e smoke read-only passaram;
- suíte física Windows positiva: 6 testes passaram; o Codex completou uma tool
  call, removeu o estado temporário e teve a árvore integralmente reapada;
- matriz física negativa: 9 testes passaram, incluindo mutação ambígua sem
  retry, com zero dispatch duplicado ou pendente;
- soak limitado: 100/100 no fixture e 5/5 no Codex real;
- nenhum runtime do produto foi selecionado, reiniciado ou alterado.
