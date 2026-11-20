# Embeddings

## O que é

Um embedding é um vetor numérico que representa a entrada de um modelo, como uma pergunta ou um trecho de código. Um modelo de recuperação procura colocar entradas relacionadas em regiões próximas do espaço vetorial. Esse tipo de representação permite recuperar conteúdo escrito com outra terminologia. [Dense Passage Retrieval, de Karpukhin et al.](https://aclanthology.org/2020.emnlp-main.550/)

## Como usamos no código

1. **Na indexação**, código ganha representações a partir de caminho, linguagem, estrutura, assinaturas e trechos do fonte, conforme o tipo de candidato. Na documentação, o texto do embedding inclui título da seção, assinatura de API quando disponível e conteúdo. A memória usa representações das entradas persistentes. [Candidatos de código](../../packages/indexer/src/indexer/indexer/embedding-candidates.ts#L26) · [Texto de documentação](../../packages/services/src/services/docs/index-doc-use-case/utils.ts#L20) · [Texto de memória](../../packages/services/src/memory/agent-memory-ranking.ts#L44)
2. **Na consulta**, `embedQueryForNamespace` obtém o vetor da pergunta. O runtime resolve o modelo da geração ativa daquela área do índice e verifica a compatibilidade da identidade do modelo (*fingerprint*). Assim a busca compara vetores produzidos no mesmo espaço. [Interface de embeddings](../../packages/indexer/src/search/embeddings.ts#L88) · [Resolução da geração ativa](../../packages/indexer/src/search/semantic-profile-runtime.ts#L295)
3. **No modo local**, o modelo empacotado é o Granite Embedding 97M Multilingual R2 em ONNX. O perfil semântico determina o modelo em uso e o código oferece outros destinos de inferência. [Modelo empacotado](../../packages/shared/src/providers/bundled-semantic-model.ts) · [Destinos de inferência](../../packages/indexer/src/search/semantic-targets.ts)

## Execução no dispositivo e exemplo

O Granite embarcado usa pesos Q8, pooling CLS e vetores normalizados de 384 dimensões. O runtime limita o tokenizador da sessão a 512 tokens. O serviço tenta DirectML no Windows, CUDA no Linux x64 e CoreML no macOS. Se a sessão ou a inferência no acelerador falhar, a mesma solicitação é repetida em CPU com o mesmo modelo. Os diagnósticos informam o provedor ONNX efetivamente carregado. [Seleção de dispositivo](../../packages/indexer/src/search/onnx-resource-policy.ts) · [Carregamento, inferência e recuperação em CPU](../../packages/indexer/src/search/local-embeddings.ts) · [Modelo Granite R2](https://huggingface.co/ibm-granite/granite-embedding-97m-multilingual-r2)

Uma consulta sobre “reaproveitar resultados recentes de consulta” pode ficar próxima de trechos que falam em `queryCache` ou em cache de resultados. A semelhança produz candidatos que ainda precisam ser lidos para confirmar a relação.

[Voltar ao índice](README.md) · [Ver como buscamos pelos vetores](busca-vetorial.md)
