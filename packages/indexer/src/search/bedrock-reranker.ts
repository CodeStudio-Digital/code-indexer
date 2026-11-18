import { bedrockClientConfig, type ResolvedCreds } from '@mcp/provider-sdk';
import type { RerankCandidate, RerankResult, RerankerService } from './reranker.js';

interface RerankClient {
  send(command: unknown): Promise<{ results?: Array<{ index?: number; relevanceScore?: number }> }>;
}

interface BedrockAgentSdk {
  BedrockAgentRuntimeClient: new (config: unknown) => RerankClient;
  RerankCommand: new (input: unknown) => unknown;
}

const MAX_TEXT_CHARS = 4_000;

/** Bedrock Agent Runtime reranker. Search degrades to the incoming RRF order;
 * probes opt into strict errors so a broken target can never be saved. */
export class BedrockReranker implements RerankerService {
  readonly name = 'bedrock';
  private readonly modelArn: string;
  private readonly strict: boolean;
  private readonly usesBedrockApiKey: boolean;
  private readonly config: ReturnType<typeof bedrockClientConfig>;
  private clientPromise: Promise<{ client: RerankClient; sdk: BedrockAgentSdk }> | null = null;

  constructor(options: NonNullable<ResolvedCreds['aws']> & {
    model: string;
    strict?: boolean;
  }) {
    this.config = bedrockClientConfig(options);
    this.usesBedrockApiKey = !!options.apiKey;
    this.modelArn = options.model.startsWith('arn:')
      ? options.model
      : `arn:aws:bedrock:${this.config.region}::foundation-model/${options.model}`;
    this.strict = options.strict ?? false;
  }

  private async client(): Promise<{ client: RerankClient; sdk: BedrockAgentSdk }> {
    if (this.usesBedrockApiKey) {
      throw new Error('Bedrock reranking requires an AWS profile or IAM credentials.');
    }
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const sdk = await import(/* @vite-ignore */ '@aws-sdk/client-bedrock-agent-runtime') as unknown as BedrockAgentSdk;
        return {
          sdk,
          client: new sdk.BedrockAgentRuntimeClient(this.config),
        };
      })();
    }
    return this.clientPromise;
  }

  async rerank(query: string, candidates: RerankCandidate[], topK = 10): Promise<RerankResult[]> {
    if (candidates.length === 0) return [];
    const fallback = (): RerankResult[] => candidates.slice(0, topK).map((candidate) => ({
      id: candidate.id,
      score: candidate.originalScore,
      originalScore: candidate.originalScore,
    }));
    try {
      const { client, sdk } = await this.client();
      const response = await client.send(new sdk.RerankCommand({
        queries: [{ type: 'TEXT', textQuery: { text: query.slice(0, MAX_TEXT_CHARS) } }],
        sources: candidates.map((candidate) => ({
          type: 'INLINE',
          inlineDocumentSource: {
            type: 'TEXT',
            textDocument: { text: candidate.text.slice(0, MAX_TEXT_CHARS) },
          },
        })),
        rerankingConfiguration: {
          type: 'BEDROCK_RERANKING_MODEL',
          bedrockRerankingConfiguration: {
            numberOfResults: Math.min(topK, candidates.length),
            modelConfiguration: { modelArn: this.modelArn },
          },
        },
      }));
      const results = response.results ?? [];
      const expected = Math.min(Math.max(0, topK), candidates.length);
      const seen = new Set<number>();
      if (results.length !== expected || results.some((result) => {
        const index = result.index;
        if (!Number.isInteger(index) || index! < 0 || index! >= candidates.length) return true;
        if (seen.has(index!)) return true;
        seen.add(index!);
        return !Number.isFinite(result.relevanceScore);
      })) {
        throw new Error('Bedrock reranker returned an incomplete or invalid result set');
      }
      return results.map((result) => {
        const candidate = candidates[result.index!];
        return {
          id: candidate.id,
          score: result.relevanceScore!,
          originalScore: candidate.originalScore,
        };
      });
    } catch (error) {
      if (this.strict) throw error;
      console.error(`[reranker] Bedrock rerank failed: ${error instanceof Error ? error.message : String(error)}`);
      return fallback();
    }
  }
}
