import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUNDLED_EMBEDDING_DIRECTORY } from '@mcp/shared/providers/bundled-semantic-model.js';

export function resolveBundledEmbeddingPath(): string {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    process.env.MCP_BUNDLED_SEMANTIC_MODELS_DIR,
    resources ? join(resources, 'semantic-models') : undefined,
    fileURLToPath(new URL('../../../../assets/semantic-models/', import.meta.url)),
    fileURLToPath(new URL('../../../../../assets/semantic-models/', import.meta.url)),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const directory = resolve(candidate, BUNDLED_EMBEDDING_DIRECTORY);
    if (existsSync(join(directory, 'onnx', 'model_quantized.onnx'))) return directory.replaceAll('\\', '/');
  }
  throw new Error('The bundled Granite embedding model is missing. Restore the semantic-models files for this checkout or installation.');
}
