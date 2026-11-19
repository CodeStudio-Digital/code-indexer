# Desempenho do editor: WebStorm → CodeStudio

## O que vale trazer

O WebStorm 2026.3 separa a aba, o documento em memória e a visualização. O editor Swing desenha o texto localmente; o realce léxico pode trabalhar a partir da alteração, e o servidor de linguagem recebe o conteúdo sem esperar por um salvamento. A comparação é arquitetural: não cronometramos os dois aplicativos lado a lado.

O CodeStudio já tem parte da mesma arquitetura. Não é preciso trocar Monaco para aplicar esses princípios:

| Área | O que o CodeStudio já faz | O que falta medir ou melhorar |
| --- | --- | --- |
| Digitação | `MonacoMount` não usa o `onChange` React que extrairia todo o texto a cada tecla. Atualiza a indicação de não salvo e adia a cópia de segurança para o estado React/Zustand. | Medir o custo da cópia após uma pausa e nas trocas de aba. |
| Pintura e abas | Monaco desenha o viewport; `EditorPane` seleciona a aba visível e ignora atualizações só de texto em arquivos comuns. | Medir a primeira abertura a frio separadamente da troca de abas com modelos já carregados. |
| Git | O gutter deriva marcações comparando o arquivo em memória com o texto em `HEAD`. | O diff completo rodava na thread do renderer. Agora o cálculo roda em um worker. A captura do texto e a aplicação das decorações ainda rodam no renderer. |
| Linguagem | `documentSync` agrupa deltas por 16 ms, versiona documentos e serializa os envios por arquivo. Os providers esperam pela sincronização antes da consulta. | Medir separadamente espera para sincronizar, transporte, tempo do servidor e aplicação da resposta. Não trocar `tsserver` por `tsgo` sem demonstrar o gargalo e testar a cobertura dos recursos. |
| Conflitos | A UI só é instalada quando o arquivo está marcado como conflitado e contém marcadores. | O parser agora faz uma só passagem e a análise roda após uma pausa de 100 ms. Decorações e CodeLens compartilham o resultado por versão; ações obsoletas são rejeitadas. |

### Mecanismos observados no WebStorm e como transferi-los

As referências abaixo são da distribuição instalada; a plataforma IntelliJ tem fontes abertos, mas isso não implica acesso a todo o fonte do WebStorm ou de seus plugins. As listagens citadas estão em `rea-webstorm-editor-language/bytecode/`.

| Evidência no WebStorm | Aplicação no CodeStudio |
| --- | --- |
| `EditorComponentImpl.javap.txt:518` chama `measureTypingLatency`; em `:552` há um diagnóstico explícito contra adquirir o lock de leitura/escrita durante a pintura. | Medir a latência até o próximo quadro do editor e tratar trabalho síncrono de Git, plugins e painéis como suspeito, mesmo quando não está diretamente no evento de teclado. |
| `DocumentMutatorImpl.javap.txt:631–659` usa `OptimizedTextReplacement` e obtém um patch para o documento. | Usar o modelo Monaco como fonte do texto vivo. Avaliar cópias completas necessárias para rascunho, troca de abas e sincronização; não trocar a estrutura de texto do Monaco sem evidência. |
| `LexerEditorHighlighter.javap.txt:481,1031` tem uma rota de atualização incremental. `DocumentCommitThread.javap.txt:1288` chama `BlockSupportImpl.reparse`, separado da pintura. | Separar realce local, análise semântica e aplicação de decorações. Invalidar por versão e medir quantas decorações são recalculadas ou aplicadas depois de uma edição pequena. |
| `LspDocumentSyncManager.javap.txt:651,695` tem envios incrementais e completos. `TypeScriptServerServiceImpl.javap.txt:7056–7066` constrói diagnósticos sintáticos e semânticos distintos. | Manter a ordem `didChange` → autocomplete; medir a fila e evitar que diagnósticos, indexação ou respostas antigas atrasem a sugestão ou ocupem a thread da interface. Não condicionar o primeiro quadro à prontidão do servidor. |

## Primeira entrega: diff do gutter Git em worker

O algoritmo de diff permanece o mesmo. A fila só inicia um worker se houver diferença, mantém no máximo um cálculo em andamento por tracker e só captura a última versão pendente. Uma edição ou troca de baseline invalida o resultado antigo imediatamente; o renderer só aceita resultados para o modelo atual. Os comandos de navegação e as ações do gutter não usam coordenadas invalidadas. Se o worker falhar, os marcadores são limpos em vez de reintroduzir o diff na thread da interface.

### Medição isolada

Chromium 149 headless, 30 amostras aquecidas por modo, alternando a execução síncrona e a versão com o worker gerado pelo build. Entrada sintética: 10.000 linhas, 538.889 caracteres no baseline e 995 blocos alterados. As duas rotas produziram resultados idênticos.

| p95 | Síncrono no renderer | Worker |
| --- | ---: | ---: |
| Atraso para um `setTimeout(0)` no renderer | 74,8 ms | 1,1 ms |
| Tempo até o resultado do diff | 74,7 ms | 81,2 ms |

O diff não terminou mais rápido; deixou a interface livre enquanto calculava. A medição não inclui `model.getValue()`, a aplicação de decorações, nem a latência tecla → pintura no app.

## Segunda entrega: análise de conflitos Git

O parser anterior podia recomeçar uma busca até o fim do arquivo para cada `<<<<<<<` sem fechamento. Além disso, decorações e CodeLens consultavam o texto inteiro de forma independente. A nova implementação percorre as linhas uma só vez e agrupa edições próximas. O cache é associado ao modelo e à versão; ações de uma versão anterior não aplicam texto em coordenadas novas.

### Medição no workbench web

Dois builds de produção do CodeStudio no Chromium, abrindo a rota do projeto, com Monaco, gutter Git e decorações de conflito confirmados. O build anterior já contém o worker do gutter, portanto este teste isola a intervenção de conflitos. A API recebeu respostas de fixture; não foi usado o backend real, o processo Electron ou o servidor TypeScript real. A métrica é do evento de tecla ao callback agendado após o próximo `requestAnimationFrame`, uma aproximação da próxima pintura, não uma medição por pixels. Foram 24 teclas por cadência nominal (22, 146 e 175 ms).

| Arquivo de 10 mil linhas; cadência nominal de 22 ms | p95 anterior | p95 novo |
| --- | ---: | ---: |
| Conflito comum | 27,4 ms | 22,6 ms |
| Estresse: um conflito válido e 2.500 marcadores incompletos | 178,4 ms | 23,3 ms |

No cenário comum, os resultados ficam próximos e não demonstram ganho geral. No estresse, a redução se repetiu nas outras cadências: 173,5 → 23,5 ms e 179,0 → 20,9 ms. O teste também confirmou a inserção das 72 teclas e que a página não lançou exceções. Os dados brutos da execução local estão em `.tmp/webstorm-editor-workbench-benchmark.json` e `.tmp/webstorm-editor-workbench-stress.json`.

## Próximos critérios de aceitação

1. Medir p50/p95/p99 de tecla → próxima pintura em arquivos pequenos e grandes, em projeto Git, com split e com LSP ativo. Registrar abertura a frio e troca de aba quente separadamente. Usar a mesma máquina, build e sequência de edição para comparar.
2. Separar nas traces o tempo de CPU do renderer, o tempo dos workers, o transporte e o tempo do servidor. Mostrar prontidão do editor e prontidão do autocomplete como medidas diferentes.
3. Atacar o maior custo medido a seguir. Candidatos: aplicação de muitas decorações, cópia para persistência de rascunhos e fila de sincronização à frente do autocomplete. Cobrir resultados atrasados, troca rápida de arquivo, undo e conteúdo não salvo.