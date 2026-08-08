# 09 — ADR: engine OSS como adapter substituível

> **Status:** aceito para continuação em P3; não aprovado para cutover
> **Data:** 2026-08-05
> **Decisão:** adapter versionado; sem fork e sem autoridade de produto no engine

## Contexto

O code-run atual mistura engine, configuração, seleção de tools, skills,
plugins, MCP e lifecycle em uma superfície extensa de flags e branches. A
pergunta do bake-off foi se deveríamos substituir essa massa por um agente OSS
completo, aproveitar componentes dele ou mantê-lo atrás de nossos contratos.

O Codex app-server foi exercitado em processo real dentro do runtime Rust. O
B2 físico completou positivo, nove cenários adversariais e soak limitado. O
Goose teve o protocolo ACP qualificado em source, mas ainda exige a fachada MCP
attempt-scoped antes de um run comparável.

## Decisão

Usar o Codex app-server somente como **engine adapter versionado e
substituível** para o P3 shadow. Não criar fork. Não promover o adapter a
default e não alterar o runtime selecionado no produto nesta decisão.

Continuam pertencendo ao CodeStudio:

- `ResolvedAttemptSpec`, policy, approvals, fencing e budgets;
- catálogo/snapshot e grants de capabilities;
- ToolHost, indexer, skills, plugins e MCP;
- TurnEngine, lifecycle tipado, session store e journal autoritativo;
- supervisor, Job Object, cancel, deadline e process-tree reap;
- telemetria, rollout, rollback e compatibilidade histórica.

O engine recebe contexto e projeção bounded, produz deltas/tool calls e pode
ser trocado por outra implementação do mesmo port. Seu thread/storage não é
fonte de verdade e seus built-ins não são caminho alternativo de execução.

## Contrato de execução de capability

O B2 adiciona a segunda fase que faltava à integração:

1. engine emite tool call pertencente ao snapshot;
2. runner envia `CapabilityPrepare`;
3. Host rejeita, pede approval ou retorna grant selado;
4. TurnEngine persiste `CapabilityDispatchStarted`;
5. para `HostCapability`, runner envia `CapabilityExecute`;
6. Host valida grant/input/deadline, deduplica por operation e executa uma vez;
7. Host retorna sucesso, falha, cancel ou `outcome_unknown`;
8. TurnEngine persiste `CapabilityTerminal` e nunca repete uma mutação ambígua.

Esse port é genérico; a prova mutante não adiciona uma ferramenta de teste ao
binário de produção. Os adapters concretos de ToolHost/indexer/MCP serão
ligados no Host durante P2/P3, sem dar acesso interno ao engine.

## Por que não um fork

O Codex passou a fronteira sem patch no core: versão/schema são pinados, os
built-ins relevantes são desligados, dynamic tools chegam ao nosso port, o
processo herda o containment da attempt e o estado efêmero é descartável. Um
fork adicionaria custo permanente de merge e segurança sem resolver um gate
atual.

Se a API experimental de dynamic tools quebrar ou não puder ser aceita, troca-se
o adapter ou reclassifica-se o candidato como `component donor`; não se cria um
fork automaticamente.

## Alternativas

- **Adotar o agente OSS como runtime completo:** rejeitado; desloca autoridade
  de policy, sessão, tools e processo para fora dos contratos do produto.
- **Forkar agora:** rejeitado; não existe patch de core necessário comprovado.
- **Usar apenas como component donor:** prematuro; B2 provou que o adapter é
  tecnicamente viável.
- **Manter somente o engine próprio:** permanece controle do B3, não fallback
  concorrente. A decisão final de qualidade depende do corpus comparativo.
- **Promover Goose em paralelo agora:** adiado; primeiro deve existir uma única
  fachada MCP attempt-scoped reutilizável.

## Evidência e consequências

Evidência aprovada:

- pacote `runtime-v1-22cc347deaf4f440a11f27f602be21c0ae75ce13709ac56de6910fba1fec3bab`;
- positivo Windows 6/6;
- matriz adversarial 9/9, incluindo mutação + ACK ambíguo;
- soak 100/100 fixture e 5/5 Codex real;
- 614 testes Rust e 432 testes TypeScript, sem falha.

Consequências:

- configuração do candidato é pequena e derivada do snapshot; não haverá
  tradução das flags antigas para centenas de opções do engine;
- upgrades exigem novo pin de binário/schema e repetição dos gates;
- a API `dynamicTools` continua risco explícito;
- dedupe atual é attempt-scoped; restart/recovery do P3 deve provar que um
  `DispatchStarted` recuperado nunca dispara novamente uma mutação sem probe;
- a bridge P3 local cobre executores reais de filesystem/shell/HTTP, o
  `ToolRegistry` unificado, spill, cancel e policy/fence; o gate físico ainda
  precisa testar MCP/plugin externos, subagentes/Company completos e restart.

## Gate de promoção

Esta ADR autoriza apenas continuar o adapter em shadow. Cutover exige:

1. corpus P3 executável com budgets/policy/model equivalentes;
2. zero regressão crítica de segurança ou dados;
3. restart/recovery sem duplicação de efeito;
4. decisão explícita sobre o risco da API experimental;
5. canário e rollback exercitados no build instalado.
