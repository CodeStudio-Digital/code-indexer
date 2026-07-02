# Pontos de Comparação com a Ferramenta Atual

Este documento lista dimensões objetivas para comparar o Codex com a ferramenta atual em etapa posterior.

## 1. Arquitetura de runtime

Codex separa claramente:

- core Rust de execução;
- protocolo compartilhado;
- TUI;
- app-server;
- SDKs;
- extensões/tools.

Comparar se a ferramenta atual possui fronteiras equivalentes ou se concentra responsabilidades em um único processo/módulo.

## 2. Modelo de sessão

Codex usa Thread → Turn → Item. Isso serve ao app-server, SDKs, histórico, streaming, fork/resume/archive e event replay.

Comparar:

- nomenclatura e granularidade de sessão;
- suporte a fork/resume/archive/delete;
- persistência de itens/tool calls/reasoning;
- compatibilidade com streaming e múltiplos clientes.

## 3. Tools

Codex divide descrição, descoberta, handler, runtime, sandbox e eventos. Há ToolSpec serializável, ToolDefinition intermediário e mecanismos de deferred/dynamic tools.

Comparar:

- formato de tool spec;
- suporte a tools namespaces/custom/freeform;
- tool search/discovery;
- integração com MCP/plugins/skills;
- execução paralela;
- runtime por tool;
- aprovações por call/path/env.

## 4. Shell, sandbox e approvals

Codex trata shell como tool de alto risco, com:

- canonicalização de comando para approval;
- cache de approval por sessão;
- guardian review;
- network approval;
- sandbox por OS;
- exec policy amendments;
- prompt específico informando restrições ao modelo.

Comparar:

- se as permissões são só enforcement ou também prompt context;
- granularidade de approval;
- suporte a retry/escalation;
- comportamento Windows/macOS/Linux;
- logs/auditoria.

## 5. apply_patch e edição

Codex usa `apply_patch` como tool freeform e também intercepta chamadas via exec. O runtime de patch integra sandbox, approval por path e registro de deltas.

Comparar:

- estratégia de edição de arquivos;
- atomicidade;
- validação prévia;
- integração com approval;
- como deltas são persistidos/exibidos.

## 6. Prompting

Codex tem templates modulares para base instructions, personalidade, permissions, goals, compaction, realtime, review, AGENTS.md, skills, plugins e multi-agent.

Comparar:

- fonte de verdade dos prompts;
- versionamento e testes de templates;
- composição por fragmentos e canais;
- visibilidade/debug do prompt model-visible;
- instruções dinâmicas de permissions/sandbox.

## 7. UI e experiência

Codex tem TUI complexa com ChatWidget, BottomPane, popups, approvals, file search, plugin catalog, memories settings, model popups e IDE context. O app-server sustenta clientes ricos como VS Code.

Comparar:

- superfície terminal vs IDE/desktop;
- roteamento de input;
- tratamento de imagens/modelos multimodais;
- status/progress/notifications;
- approvals e permission popups;
- suporte a contextos de IDE.

## 8. App-server/protocolo externo

Codex expõe app-server JSON-RPC com schema gerável, backpressure explícito, lifecycle claro e APIs para filesystem, process, config, models, plugins, MCP e goals.

Comparar:

- se há protocolo externo estável;
- schema gerado/versionado;
- backpressure;
- subscription/unsubscribe;
- multiplexação de eventos;
- suporte a clients múltiplos.

## 9. SDKs

Codex oferece Python SDK high-level sobre app-server e TypeScript SDK sobre CLI/JSONL.

Comparar:

- existência de SDKs oficiais;
- abstrações expostas;
- sync/async/streaming;
- auth;
- structured output;
- controle de sandbox/cwd/env.

## 10. Extensibilidade

Codex combina MCP, plugins, skills, app connectors, marketplaces e capability roots selecionáveis por ambiente.

Comparar:

- modelo de extensões;
- instalação/descoberta;
- escopo por projeto/ambiente;
- autenticação de apps/MCP;
- skill invocation e policy.

## 11. Estado, memória e goals

Codex persiste rollout JSONL e metadados em SQLite. Possui goals com budget/tokens/status, memory reset/mode e context compaction.

Comparar:

- formato de persistência;
- queryability;
- memória cross-session;
- goal tracking;
- compaction/summarization;
- compatibilidade com long-running objectives.

## 12. Segurança corporativa

Codex inclui requirements.toml/MDM-like constraints, allowed policies, allowed sandbox modes, feature pins, residency, hooks lockdown e compliance client names.

Comparar:

- controles admin;
- logs/auditoria;
- compliance identifiers;
- políticas por workspace;
- restrições de rede/domínio.

## Hipóteses para investigação futura

- O maior diferencial técnico do Codex é a combinação de app-server + protocolo + runtime Rust sandboxed.
- A UX TUI é secundária ao contrato de runtime; clientes ricos usam app-server.
- Prompting e enforcement são acoplados: o modelo recebe instruções geradas da policy efetiva.
- Extensibilidade se apoia em MCP/plugins/skills, não apenas em tools hardcoded.
- Comparação justa deve separar “agent loop” de “desktop/IDE control plane”.
