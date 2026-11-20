# Recuperação local com ONNX e sqlite-vec

## O que é

Recuperação local executa etapas como gerar embeddings e consultar os índices na máquina do usuário. Com o modelo e o corpus disponíveis localmente, essas etapas podem funcionar offline.

## Como usamos no código

- **Inferência.** `LocalEmbeddingService` usa Transformers.js com ONNX. O modelo empacotado é o Granite Embedding 97M Multilingual R2. O desktop encaminha a inferência ONNX e a busca em `sqlite-vec` para o worker dedicado `semantic-vector-worker`. [Serviço local](../../packages/indexer/src/search/local-embeddings.ts) · [Modelo](../../packages/shared/src/providers/bundled-semantic-model.ts) · [Integração do desktop](../../apps/http-api/server/deps.ts#L738) · [Worker](../../apps/http-api/workers/semantic-vector-worker.ts)
- **Armazenamento.** `LocalVectorRouter` resolve o namespace e a geração para o arquivo de banco e a tabela vetorial. Código é separado por projeto, documentação por coleção e memória global do usuário tem rota própria. O índice textual usa SQLite FTS5. [Identidades dos namespaces](../../packages/shared/src/vector-namespace.ts) · [Roteamento físico](../../packages/store/src/local-vector-route-resolver.ts)
- **Troca de modelo.** A consulta usa o modelo da geração ativa. Uma geração em construção pode receber vetores de um novo modelo e servir após a ativação. A migração para o Granite preserva os vetores ativos até a publicação de uma nova geração. [Resolução da leitura e da escrita](../../packages/store/src/local-vector-route-resolver.ts#L54) · [Migração do modelo empacotado](../../packages/store/src/migrations/278_bundled_granite_embedding.ts)

## Exemplo

Com um projeto já indexado e o Granite ativo, uma pergunta pode ser convertida em vetor e consultada em `sqlite-vec` com a rede indisponível. A geração da resposta e expansões como HyDE têm suas próprias configurações de modelo. Elas podem depender de rede se usarem um provedor remoto. [Perfil semântico](../../packages/indexer/src/search/semantic-targets.ts) · [Configuração de HyDE](../../packages/indexer/src/search/hyde.ts#L59)

[Voltar ao índice](README.md) · [Ver a busca vetorial](busca-vetorial.md)
