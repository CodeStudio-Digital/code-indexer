/**
 * JSONL export — streams accepted examples to disk in chat format
 * (`{"messages":[{role,content}…]}`, one per line) so the Python trainer can
 * consume them directly. Reserves a holdout slice (written to a separate file)
 * for the eval-harness baseline/after comparison.
 *
 * Streaming via `appendFile` keeps memory flat regardless of dataset size.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { GeneratedExample } from './types.js';

export interface JsonlPaths {
  trainPath: string;
  holdoutPath: string;
}

export function datasetPaths(dataDir: string, datasetId: number): JsonlPaths {
  const base = `${dataDir}/training/datasets/${datasetId}`;
  return { trainPath: `${base}.jsonl`, holdoutPath: `${base}.holdout.jsonl` };
}

function toChatLine(ex: Pick<GeneratedExample, 'instruction' | 'input' | 'output'>): string {
  const userContent = ex.input ? `${ex.instruction}\n\n${ex.input}` : ex.instruction;
  return JSON.stringify({
    messages: [
      { role: 'user', content: userContent },
      { role: 'assistant', content: ex.output },
    ],
  });
}

export class JsonlWriter {
  private ready: Promise<void>;

  constructor(private paths: JsonlPaths) {
    this.ready = mkdir(dirname(paths.trainPath), { recursive: true }).then(() => undefined);
  }

  async append(
    ex: Pick<GeneratedExample, 'instruction' | 'input' | 'output'>,
    isHoldout: boolean,
  ): Promise<void> {
    await this.ready;
    const path = isHoldout ? this.paths.holdoutPath : this.paths.trainPath;
    await appendFile(path, `${toChatLine(ex)}\n`, 'utf-8');
  }
}
