# Envio durante execucao e fila de mensagens — 3.16.17

O composer misturava duas intencoes: o botao Enfileirar enviava imediatamente
para `/inject`, enquanto a opcao de esperar mantinha uma fila apenas no componente.
Uma troca de conversa apagava essa fila. Erros eram ignorados e, apos uma falha
de `/inject`, o cliente abria um segundo POST/SSE, podendo substituir o stream
ativo ou reenviar uma operacao ja aceita.

## Comportamento corrigido

- **Enviar agora / Ctrl+Enter:** encaminha orientacoes para o proximo ponto de
  consumo do runner. A ferramenta em curso nao e abortada. Perguntas interativas
  sao liberadas somente depois de persistir a mensagem.
- **Enfileirar / Ctrl+Shift+Enter:** espera a execucao terminar e envia uma tarefa
  por execucao, em ordem. Cada item pode ser enviado individualmente ou removido
  antes de sua transmissao.
- A mesma fila atende o chat completo e o painel do editor. Navegar para outro
  chat preserva a fila original, que continua acompanhando sua propria execucao.
- A fila e os anexos sao persistidos em IndexedDB. Apos recarregar a janela,
  mensagens restauradas ficam pausadas para retomada explicita. Fechar o aplicativo
  encerra o despachante da interface; nao foi criado um servico de envio offline.
- Erros de entrega preservam o item e pausam a fila. Parar nao dispara a proxima
  tarefa. Um estado transitorio de desconexao tambem nao equivale a conclusao.
- A interface diferencia espera, transmissao, confirmacao de recebimento e consumo
  pelo agente. Um item ja recebido nao oferece cancelamento que nao poderia cumprir.
- Ao excluir um chat, sua fila local e eliminada; filas vazias sem observadores
  liberam callbacks e assinaturas. Nao ha polling nem temporizadores por item.

## Contrato de entrega

O POST `/api/coder/sessions/:id/messages` aceita `response_mode: "json"` para
retornar um recibo e manter a observacao SSE separada. A admissao continua usando
a identidade duravel `client_msg_id` do controle existente. Falhas de HTTP nao
provocam envio alternativo. Repetir o mesmo comando recupera seu recibo/resultado.

`only_when_idle` impede que uma tarefa adiada vire uma orientacao no meio de outra
execucao. A resolucao de idempotencia precede essa verificacao: um recibo perdido
apos iniciar a execucao precisa ser recuperado, sem criar uma segunda tarefa.
Anexos passam pelas mesmas validacoes e autorizacoes de referencias locais.

## Validacao

- Regressao da fila: ordem, entrega serial, confirmacao, consumo antecipado,
  anexos, pausa, retomada, erros, exclusao e persistencia.
- API: recibos JSON, retries simultaneos, execucao nova/ativa/concluida,
  tarefa adiada, anexos e ordem persistir/retomar perguntas.
- Navegador com o Composer real: sete cenarios, incluindo atalhos, recarga,
  troca de conversa, operacao em segundo plano e largura de 420 px.
- As respostas de modelo e de transporte nos testes sao controladas; nao se trata
  de um teste com contas de provedores ou projetos reais do usuario.

Evidencias locais desta entrega: `.tmp/message-queue-20261109/`.
