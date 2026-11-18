# Memória e aprendizado — CodeStudio 3.16.18

## Diagnóstico

O perfil semântico de memória já fornecia embeddings e reranking. A aplicação ainda acrescentava modelos de texto para reescrever consultas e filtrar resultados, enquanto o consolidador mais completo operava sobre snapshots legados. A tela misturava inventário, uso, aprendizado e cobertura em dois cabeçalhos redundantes.

A inspeção **somente de leitura** da instalação 3.16.17 confirmou, no projeto 10:

- Projeto: 318 memórias, 271 indexadas, 33 ausentes e 14 falhas.
- Globais: 232 memórias, 222 indexadas, 6 ausentes e 4 falhas.
- Perfil: `nvidia/llama-nemotron-embed-vl-1b-v2:free` e `nvidia/llama-nemotron-rerank-vl-1b-v2:free`, via OpenRouter.
- Erro preservado na geração do projeto: HTTP 429, `free-models-per-min`, limite informado de **20 requisições/minuto**. Tentativas anteriores esgotaram o contador e bloquearam a retomada. O diagnóstico global antigo perdeu o detalhe do provedor e preservou apenas uma mensagem genérica.

Não foram alterados bancos, memórias, credenciais ou modelos da instalação em execução. Os testes usam dados sintéticos e provedores simulados.

## Funcionamento implementado

1. **Busca**: FTS + embeddings do perfil Memória, fusão dos resultados e reranker do mesmo perfil. O reranker também funciona quando só há candidatos textuais. Falhas semânticas preservam a busca textual. Consultas não fazem mais chamadas LLM adicionais de reescrita/filtro.
2. **Aprendizado**: uma chamada ao destilador para fatos, erros corrigidos e procedimentos verificados. O prompt distingue evidência nova, hipótese, preferências globais e contexto de projeto. Repetição não aumenta importância nem fixa uma memória automaticamente.
3. **Evolução**: revisão incremental da base `agent_memory`, acionada por novos registros. Consolida fatos compatíveis, refina redação e arquiva informação substituída por correção mais recente. Não usa repetição, popularidade ou similaridade do título como prova de verdade.
4. **Proteção e histórico**: alterações criam uma versão nova e arquivam as anteriores. Memórias manuais, fixadas, preferências e referências externas não são alvos da revisão. Hashes históricos de arquivos são preservados; evidência conflitante fica desconhecida, nunca é recapturada como se fosse antiga. Restaurar uma memória pela interface a torna manual, evitando que seja arquivada novamente automaticamente.

A revisão compara as versões lidas com as atuais, rejeita IDs fora do conjunto de evidências ou de outro projeto e aplica conteúdo, histórico e cursor em uma transação. Falha, cancelamento ou perda de posse não consomem o trecho pendente. Uma substituição exige uma citação literal de um registro mais recente. As decisões semânticas continuam dependentes da qualidade do modelo e podem ser inspecionadas/restauradas.

## Limites de trabalho

- Um trabalho de revisão por processo; posse persistida impede dois processos de revisar o mesmo escopo simultaneamente.
- Até dois escopos por rodada; varredura a cada 60 segundos, início após 30 segundos.
- Oito novas memórias por escopo, até duas buscas de vizinhos, conjunto de até 24 registros e 48 mil caracteres; registros individuais acima de 8 mil caracteres não são enviados para reescrita automática.
- Até quatro operações por resposta; prazo de 90 segundos por revisão, posse de 180 segundos e intervalo normal de cinco minutos por escopo.
- Falhas mantêm entradas pendentes e recebem espera progressiva. Solicitações manuais de outro projeto aguardam sua vez.
- Saídas do próprio consolidador não alimentam um ciclo infinito; voltam a ser candidatas somente quando há nova evidência relacionada.
- `MCP_MEMORY_EVOLVE=0` desativa a evolução; a chave de memória automática de cada projeto também é respeitada.

## Cobertura semântica

O backfill agrupa até **32 textos/chunks** por chamada, reutiliza vetores atuais e mantém a geração de destino em cada gravação. Uma resposta incompleta não é registrada como cobertura completa. Uma falha de quota interrompe o lote restante, preserva a causa e a orientação de espera.

Chamadas gratuitas do OpenRouter compartilham um intervalo local de 3,5 segundos entre embeddings e reranking. HTTP 429 e `Retry-After` impõem espera; pausas longas falham rapidamente para permitir a alternativa textual. Quotas temporárias não bloqueiam definitivamente após oito tentativas. Bloqueios legados com causa 429 conhecida voltam a ser elegíveis; causas antigas perdidas/genéricas ainda podem exigir **Reparar cobertura** após revisar a configuração.

Isso reduz chamadas e evita repetição agressiva; não elimina quotas de conta, indisponibilidade remota ou tráfego de outros aplicativos.

## Interface

- Um cabeçalho de inventário e dois cartões: aprendizado e uso nas conversas.
- Uso distingue consultas com resultados, injeções no contexto e leituras explícitas. Não apresenta esses números como prova de que o agente obedeceu à memória.
- Cobertura por projeto/globais com contagens, progresso, causa classificada, próxima tentativa, modelos e reparo com confirmação para envio remoto.
- Busca e curadoria por escopo, páginas de até 40 itens, versões arquivadas, motivo legível e navegação até a versão atual.
- Um único pipeline LLM de aprendizado; bindings antigos de consulta/filtro ficam desativados e preservados no banco, sem aparecer como configurações ativas.
- Resumo atualizado a cada 30 segundos enquanto visível/ativo, sem percorrer históricos de conversas; cobertura atualiza a cada cinco segundos somente durante reparo. A tela não dispara inferência ao ser consultada.
- Removidos os dois cartões antigos e efeitos React que copiavam dados carregados para vários estados do formulário ou reiniciavam ações durante atualizações.

## Comparação verificável

| Caminho | Antes | Depois |
|---|---|---|
| Modelos LLM configuráveis para memória | Extração, reescrita da busca e filtro de recall | Um modelo para aprendizado/revisão; busca no perfil semântico |
| Aprender fatos + correções + procedimentos | Até três chamadas | Uma chamada em execução bem-sucedida sem failover |
| Backfill sintético de 40 memórias curtas | Uma chamada por memória: 40 | Duas chamadas: lotes de 32 e 8 |
| Atualização do resumo | 8 s; KPIs consultavam históricos | 30 s; agregações da base compartilhada |
| Deduplicação no índice/busca | Similaridade de título e palavras podia ocultar fatos distintos | Deduplicação exata conservadora; revisão semântica com histórico |
| Quota após muitas tentativas | Bloqueio permanente | Espera e retomada para 429 conhecido |

A redução de 95% nas chamadas de backfill foi verificada com um provedor simulado. Não é uma medição de latência, qualidade ou disponibilidade do serviço gratuito real. Não foi feita uma avaliação longitudinal de aderência dos agentes às memórias.

## Verificação

- 332 testes em 32 arquivos: busca, lotes, extração, evolução, isolamento, alterações concorrentes, cancelamento, rollback, histórico, restauração, migração, quota, API e coordenação semântica.
- Sete testes Chromium: contagens, diagnóstico, escopos, busca, revisão, reparo, edição e versões anteriores; capturas em 1280×1000 e 420×900.
- TypeScript do backend/dashboard e ESLint dos componentes alterados aprovados.
- Evidências locais: `D:/MCP/.tmp/memory-evolution-20261109/`.
- Pacote 3.16.18 verificado com o executável distribuído: SQLite nativo 3.53.2, migração 275 e execução sintética de consolidação aprovados em perfil isolado.
- Todos os **4.948 arquivos** extraídos do instalador conferem, por SHA-256, com o pacote verificado. O instalador não foi executado sobre a instalação do usuário.
- Os processos temporários de teste foram encerrados e a saída foi confirmada.

## Instalador

- Arquivo: `D:/MCP/dist/electron-memory-3.16.18-20261109/CodeStudio Setup 3.16.18.exe`.
- Tamanho: 341.042.180 bytes.
- SHA-256: `e63ec407ed7e1bd1f6dda51a888a150fb5945dfbf2f28bfec195c21cdd349522`.
- Assinatura Authenticode: `NotSigned`.
- Recibo: `D:/MCP/.tmp/memory-evolution-20261109/release-receipt.json`.
- Após atualizar, bloqueios antigos com diagnóstico genérico podem exigir um acionamento de **Reparar cobertura**. A cobertura só aumenta quando o provedor aceita os lotes; os números da base real não foram alterados durante esta validação.

## Embeddings/reranker gratuitos

Embeddings e rerankers atendem à recuperação; não substituem um modelo de texto que extrai lições e propõe revisões. Por isso o pipeline de aprendizado permanece.

Consulta à documentação oficial durante esta revisão:

- [NVIDIA embed VL v2 gratuito no OpenRouter](https://openrouter.ai/nvidia/llama-nemotron-embed-vl-1b-v2:free): a página anuncia retirada em **16/11/2026** e condições de uso experimental/logging. O perfil existente não foi trocado silenciosamente.
- [NVIDIA rerank VL v2 gratuito](https://openrouter.ai/nvidia/llama-nemotron-rerank-vl-1b-v2:free).
- [Nemotron 3.5 Embed 1B](https://openrouter.ai/nvidia/nemotron-3.5-embed-1b:free) e [Nemotron 3.5 Rerank 8B](https://openrouter.ai/nvidia/nemotron-3.5-rerank-8b:free): alternativas listadas, cuja disponibilidade deve ser testada antes de mudar o perfil.
- [API de embeddings do OpenRouter](https://openrouter.ai/docs/api_reference/embeddings) e [reranking NVIDIA](https://docs.nvidia.com/nemotron/nightly/nemotron/rerank/text.html).

Trocar embeddings exige uma nova geração vetorial; nunca se devem misturar vetores de modelos diferentes. A versão nova mantém o perfil escolhido e a confirmação existente para reparos que enviam memórias ao provedor remoto.
