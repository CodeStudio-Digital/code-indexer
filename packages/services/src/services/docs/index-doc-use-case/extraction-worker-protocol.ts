import type { FolderFileEntry, ReadFileResult } from '../folder-reader.js';
import type { SectionChunk } from '../section-chunker.js';

export interface DocExtractionRequest {
  entry: FolderFileEntry;
  rootPath: string;
  sourceId: number;
}

export interface DocExtractionResponse {
  result: ReadFileResult;
  sections: Array<{ candidateId: string; chunks: SectionChunk[] }>;
  durationMs: number;
}
