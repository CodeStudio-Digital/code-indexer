# Ultra v3 — coordenação e qualidade dos agentes

**Estado: SPEC proposta, sem implementação nesta entrega.** Estudo estático de 26/10/2026, America/Sao_Paulo. Destino: CodeStudio em `D:\MCP`. Referência: snapshots locais do Claude Code CLI **2.1.308 stable** e Claude Desktop **3.6556.2**, em `D:\Claude-Open`.

O objetivo é fazer o Ultra concluir trabalho com melhor contexto, divisão de responsabilidades, recuperação e critério de parada. A quantidade de agentes, chamadas e testes é um custo a justificar, não uma medida de qualidade.

## Decisão central

Evoluir o Ultra existente para uma política executável de coordenação, apoiada no runner, no DAG, nos worktrees e no armazenamento de sessões que já existem. O trabalho prioritário está nas ligações entre esses componentes: configuração efetiva, resultados tipados, orçamento compartilhado, entrega de mensagens, retomada e encerramento.

O snapshot novo corrige uma premissa do atlas anterior: `/effort ultracode` agora liga a orquestração **sem alterar o esforço de raciocínio**. Ainda existem gates de disponibilidade e compatibilidade; o alias legado de inicialização pode continuar selecionando `xhigh`. Isso não justifica enviar `ultra` como esforço genérico aos nossos providers. Evidências C02–C04 em [01](01-evidencias-comparacao.md).

## O que muda para o usuário

| Situação | Comportamento especificado |
|---|---|
| “Gere um instalador” | Compila, faz a checagem mínima aplicável e entrega o arquivo. Não transforma o pedido em uma homologação completa. |
| Implementação em várias áreas | Ultra escolhe uma divisão com donos, dependências, resultados e verificações explícitos; a UI mostra o motivo. |
| Um agente termina | O coordenador recebe um evento persistido; não precisa executar um ciclo de consultas. |
| Dois chats colaboram | Mensagem tem origem, destinatário, correlação e recibo reais. “Na fila” não significa “lida” ou “resolvida”. |
| Surge uma boa tarefa adicional | Aparece uma proposta separada, com motivo e escopo. Só vira execução quando houver autorização aplicável. |
| “Confira novamente em 10 minutos” | Cria um agendamento visível, cancelável e com política de retomada; não mantém um processo/modelo dormindo. |
| Processo cai ou limite é atingido | Retoma trabalho conhecido com a configuração registrada. Efeitos incertos são reconciliados antes de repetir. |
| Testes necessários passaram | Encerra a tarefa. Nova rodada exige alteração, falha ou risco ainda não resolvido. |

## Documentos normativos

Implementação autorizada posteriormente: consulte [código integrado, validações e limites](IMPLEMENTATION.md). O restante deste documento preserva o escopo histórico do estudo inicial.

| Documento | Conteúdo |
|---|---|
| [01 — Evidências e comparação](01-evidencias-comparacao.md) | O que os dois snapshots mostram, limites e diferenças em relação ao nosso código |
| [02 — Ultra, runtime e qualidade](02-ultra-runtime-qualidade.md) | Política efetiva, plano, scheduler de passos, resultado, verificação e término |
| [03 — Tools, execução e contexto](03-tools-execucao-contexto.md) | Descoberta, projeção, MCP, processos, contexto e integração com a spec anterior |
| [04 — Chats, sugestões e agendamentos](04-chats-sugestoes-agendamentos.md) | Mailbox, espera, retomada, propostas, timers e UX |
| [05 — Entrega, migração e avaliação](05-backlog-migracao-validacao.md) | Backlog por prioridade, arquivos responsáveis, aceitação, rollout e rollback |
| [Manifesto de evidências](evidence-manifest.json) | Identidade dos arquivos citados, proveniência dos snapshots e limites da análise REA |

## Relação com o trabalho anterior

- [Agent/IDE reliability](../agent-ide-reliability/README.md) continua responsável por indexação, catálogo de capabilities, dispatcher, execução e database. Esta SPEC consome seus contratos; não cria outro catálogo, índice, executor de comandos ou pool de bancos.
- O [atlas anterior](../../research/claudeopen-convergence/README.md) estudou versões anteriores. Suas decisões de preservar capacidades próprias continuam úteis; os detalhes de `ultracode` daquela versão não são a verdade do snapshot 2.1.308.
- A [auditoria Ultra de 25/10](../../audits/2026-10-25-ultra-chat-collaboration.md) registra infraestrutura já entregue. Não se trata de começar colaboração do zero.
- Baseline Git observado: `448d526dd2e24247617938721c0d8cf18ce850cf`, **com alterações locais**. O manifesto identifica os arquivos realmente lidos; o hash do commit sozinho não representa este checkout.
- Preservar runtime TypeScript, BT runner, sessões em filesystem, Company Mode, ferramentas existentes e integrações de providers. Nenhuma migração para Rust ou serviço cloud obrigatório.

## Prioridade recomendada

1. **P0:** política efetiva coerente; stop/cancel; retomada sem duplicar efeitos; mensagens/esperas com resultado explícito; orçamento compartilhado; verificação proporcional.
2. **P1:** DAG que libera cada dependente quando pronto; contratos de resultado; propostas de tarefas; retomada por eventos e timers persistidos.
3. **P2:** templates de qualidade, ranking de sugestões e otimizações de contexto/cache comprovadas por avaliação.

Não adotar por imitação: custo ilimitado, dezenas de agentes por padrão, revisão de tudo, polling para eventos internos, limites de cache fixos para todos os providers ou cópia do runtime/prompt proprietário. As propostas abaixo são contratos próprios derivados dos problemas observados.

## Alcance da evidência

Os aplicativos Claude não foram instalados nem executados nesta investigação. Os relatórios de extração e AST são evidência fornecida pelo acervo e foram lidos, não refeitos. A análise de código estabelece fluxos estáticos, não a disponibilidade de flags para uma conta, nem qualidade comparativa dos modelos. A análise REA selecionou quatro módulos do CLI; relações externas a esse recorte e limites do grafo estão registrados. Foram consultadas também páginas oficiais, identificadas separadamente no capítulo 01.

Esta entrega altera apenas documentação nova nesta pasta. Os critérios de teste são um plano para a implementação futura, não uma alegação de que já passaram.
