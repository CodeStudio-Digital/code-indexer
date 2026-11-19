export const BUNDLED_EMBEDDING_DIRECTORY = 'granite-embedding-97m-multilingual-r2';
export const BUNDLED_EMBEDDING_TARGET = {
  kind: 'onnx',
  model: 'onnx-community/granite-embedding-97m-multilingual-r2-ONNX',
  revision: '536a9f241cb3f02a9c5995a1e708c784bd274859',
  dtype: 'q8',
  pooling: 'cls',
  normalize: true,
  queryTemplate: '{text}',
  documentTemplate: '{text}',
  maxTokens: 512,
} as const;
