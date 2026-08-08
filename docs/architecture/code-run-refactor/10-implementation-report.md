# 10 — Relatório de implementação e handoff

> **Snapshot:** 2026-08-05
> **Worktree:** `D:\MCP-worktrees\oss-agent-bakeoff`
> **Branch:** `codex/oss-agent-bakeoff`
> **Baseline:** `7e79171d4c9a98397d3f47d9437d890e9316dc1d`

## Resultado

P0-P2 e o slice local de P3 estão implementados na worktree. O adapter Codex,
a ponte genérica de `HostCapability` e a composição real
`ToolRegistry -> CapabilityGateway -> HostCapability` completaram B2 e a prova
local do executor. A seleção do runtime do produto não foi alterada. O restante
de P3 e P4 depende de execução física no build instalado e permanece gate de
produção, não trabalho silenciosamente presumido como aprovado.

## Configuração

- `RuntimePolicy` v1 é tipada, versionada, resolvida uma vez por attempt e
  acompanhada de snapshot, provenance e SHA-256.
- main, worker e `runCoder` recebem a policy resolvida; decisões normais não
  consultam env no meio da attempt.
- defaults consolidados viraram invariantes ou constantes internas; branches e
  settings mortos foram removidos.
- a migration 266 apaga rows históricas obsoletas sem transformar migrations
  antigas em fonte de autoridade atual.
- o catálogo administrativo foi reduzido para 97 settings e 9 categorias.

Audit reproduzível:

```text
AST scanned 4189 files, 324 distinct env reads
cataloged: 74; excluded: 43; review: 196
code-run disposition: 15 classified, 0 unclassified
code-run dynamic env access: 0
rollout manifest: valid
```

As 15 leituras restantes são deliberadas: 4 rollouts, 4 entradas de bootstrap
e 7 configurações com migração para o domínio proprietário. As rollouts
`CODER_AGENT_RUN_STORE_ENFORCE`, `CODER_AGENT_RUN_STORE_SHADOW`,
`CODER_CONTROL_PLANE_SHADOW` e `CODER_RUNTIME_JOURNAL_SHADOW` expiram em
2026-09-30 e possuem owner, métrica, gate e rollback receipt no manifesto.

## Capabilities, tools, skills, plugins e MCP

- `ToolRegistry` é selado antes da execução; registro ou filtro tardio falha.
- MCP e plugins são carregados antes do seal. Um servidor tardio só participa
  de uma próxima attempt.
- catálogo autorizado e projeção do provider têm digests SHA-256 distintos e
  persistidos em telemetria.
- `capability_catalog` fornece `search`, `list`, `describe` e `activate` para
  tools nativas, ToolHost/indexer, MCP, plugins e skills.
- list/search são bounded; describe limita cada descriptor a 8 KiB e a resposta
  a 64 KiB. Metadados externos são sanitizados e carregam provenance.
- skill ativada não concede capability: requisitos ausentes são rejeitados e o
  corpo autorizado é registrado como input da sessão.

## Engine OSS e fronteira de execução

O Codex app-server fica atrás de um adapter substituível, sem fork e sem
autoridade sobre policy, sessão ou tools. Built-ins e MCP próprios do engine são
desligados; chamadas entram no port do CodeStudio.

Evidência B2 congelada:

```text
package:  runtime-v1-22cc347deaf4f440a11f27f602be21c0ae75ce13709ac56de6910fba1fec3bab
manifest: bf9998a1d8301ac16d82f49d798dfd524345ea7d5f59cc8d212c9a514721aa79
fixture:  d8f703c2e1d8cf6f21acdac7bde5bab13209e1785649d8fbabb6d37f6291c97f
negative: 9/9
Windows:  6/6
soak fixture: 100/100
soak Codex real: 5/5
```

O gateway valida grant, input, deadline e correlação, deduplica por operation e
executa no máximo uma vez. ACK mutante ambíguo termina como `outcome_unknown` e
não é repetido.

O slice P3 local adiciona uma factory que exige a autoridade de policy do
produto e liga o catálogo selado aos handlers reais. Filesystem, shell e HTTP
foram exercitados fisicamente; MCP/indexer, plugin, skill, subagente e Company
passam pelo mesmo executor. O wire usa `codestudio.tool-result.v1`, com commit
durável antes do cap/spill, erro estruturado e decoder Rust fail-closed.

## Validação executada

- contratos TypeScript de `agent-runtime-contracts`: 6 arquivos, 51 testes;
- contratos TypeScript de `agent-runtime-host`: 53 arquivos e 440 testes
  aprovados; 3 arquivos e 17 testes físicos condicionais ignorados;
- typecheck TypeScript raiz (`tsc --noEmit`): limpo;
- suíte Node ampla de code-agent: 265 arquivos, 2.410 testes aprovados;
- corpus catálogo + bridge P3 local: 2 arquivos, 25 testes aprovados;
- três suítes ABI SQLite executadas com Electron-as-Node: aprovadas;
- testes do audit/manifest: 2 arquivos, 5 testes aprovados;
- audit env estrito: aprovado;
- B2 congelado: 614 testes Rust e 432 testes TypeScript aprovados no pacote de
  evidência;
- `agent-runner --lib`: 130 testes Rust aprovados neste snapshot;
- `cargo check --workspace --all-targets --locked`, `cargo fmt --check`, lint e
  build dos protos, frozen lockfile, limite de LOC e fronteira de crates:
  aprovados.

O ratchet `check:agent-boundary` continua vermelho no baseline: a branch
principal já contém 126 referências novas e 55 remoções em relação ao arquivo
histórico. A worktree termina com as mesmas 126 referências (e 67 remoções),
sem acrescentar dívida de fronteira; o baseline não foi ampliado para mascarar
o problema preexistente.

O `DataZone.tsx` agora é fonte rastreável e a exceção correspondente corrige a
regra genérica `data/` do `.gitignore`. O dashboard de produção compilou 6.157
módulos e o build TypeScript raiz também foi aprovado.

O instalador Windows foi gerado em
`dist/installer-final/CodeStudio Setup 3.15.1.exe` (272.382.754 bytes), com
SHA-256 `8D640A1278F950070B4EBB7BA3CC8C3048778D304390234435EBF17178528DD5`.
O verificador oficial aprovou module closure (2.311 módulos, 47 pacotes, zero
ausentes), pintura do renderer, deep-link e parsing tree-sitter/WASM. O
`latest.yml` corresponde byte a byte ao tamanho e SHA-512 do EXE. O artefato é
funcional, mas não possui assinatura Authenticode e poderá exibir SmartScreen.

O pipeline de release também passou a declarar o repositório explicitamente e
traduz `--target=nsis` para a sintaxe suportada `--win nsis`.

## Gates restantes para produção

1. Rodar P3 físico com MCP/plugin externos, subagente/Company completos e
   restart/recovery; filesystem, shell e HTTP locais já estão cobertos.
2. Comparar resultado, custo, latência e tool traces com budgets/model/policy
   equivalentes; nenhuma regressão crítica pode ser aceita.
3. Assinar o instalador com certificado de code signing e abrir canário por
   attempt com receipts persistidos.
4. Exercitar rollback real sem duplicação de efeito e sem perder sessão.
5. Promover ou retirar as quatro rollouts antes de 2026-09-30.
6. Só então alterar o default do runtime e iniciar P5-P6.

Até esses gates, “implementação pronta para revisão” é o estado correto;
“cutover concluído” não é.
