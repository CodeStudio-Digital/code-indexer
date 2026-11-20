# Recuperação de memória do agente

## O que é

A memória persistente permite recuperar fatos úteis de sessões anteriores, como uma decisão de arquitetura, uma convenção ou um problema conhecido. As entradas selecionadas entram no contexto da tarefa atual ou aparecem quando o agente pede uma consulta explícita.

## Como usamos no código

1. **Gravação e escopo.** `remember` registra entradas em `agent_memory`. O agente pode consultar memória do projeto ou do usuário com `recall_memory`. O serviço separa as buscas por escopo e usa FTS e vetores quando disponíveis. [Ferramentas de memória](../../packages/code-agent/src/tools/project-memory-tools.ts) · [Serviço de busca](../../packages/services/src/memory/agent-memory-service.ts#L318)
2. **Seleção.** `AgentMemoryRetriever` reordena a lista inicial usando posição, importância, recência, frequência de uso, tipo e desatualização. Para a recuperação automática, pode aplicar um limiar, favorecer variedade de tipos e passar por um filtro adicional de relevância. O estado das referências considera os hashes registrados no índice de arquivos. [Recuperador](../../packages/services/src/memory/agent-memory-retriever.ts) · [Cálculo da pontuação](../../packages/services/src/memory/scoring.ts#L60) · [Referências a arquivos](../../packages/store/src/db/agent-memory-references.ts)
3. **Injeção no contexto.** O runner pode buscar proativamente na primeira interação e quando a tarefa muda. Os resultados selecionados entram como lembrete para o modelo, com aviso de desatualização quando aplicável. [Chamada antes da montagem de mensagens](../../packages/code-agent/src/core/runner/nodes/executing.ts#L201) · [Formato do lembrete](../../packages/code-agent/src/core/runner/assembly/dynamic-injection.ts#L293)

## Exemplo

Quando o usuário pede para ignorar a memória, o agente suprime a leitura do catálogo inicial, a recuperação automática e as ferramentas de consulta à memória persistente nessa tarefa. Isso abrange memórias do projeto e do usuário. [Detecção do pedido](../../packages/shared/src/memory-opt-out.ts) · [Preparação do contexto](../../packages/services/src/services/task-preflight/preflight-context.ts) · [Testes das ferramentas](../../packages/code-agent/src/tools/__tests__/project-memory-tools.test.ts)

“Que convenção seguimos para configurar o cache de buscas?” pode recuperar uma decisão registrada em outra sessão. Se um arquivo referenciado mudou desde o registro, a lembrança pode vir sinalizada para que o agente confirme a implementação atual.

[Voltar ao índice](README.md) · [Ver as camadas do sistema de memória](../memory-system.md)
