import {
  ArtifactStore,
  type SessionId,
} from '@mcp/session-storage';
import { projectConversation } from './conversation-codec.js';
import { FsSessionDirectory } from './session-directory.js';
import type { FsSessionSnapshotRepository } from './snapshot-repository.js';

export interface FsReviewEvidenceToolCall {
  args_json: string;
  result_text: string | null;
  is_error: number;
  created_at: string;
}

export interface FsReviewEvidenceEdit {
  file_path: string;
  applied_at: string;
}

export interface FsReviewEvidenceSource {
  listReviewEvidenceToolCalls(
    sessionId: SessionId | string,
    limit?: number,
  ): Promise<FsReviewEvidenceToolCall[]>;
  listReviewEvidenceEdits(
    sessionId: SessionId | string,
  ): Promise<FsReviewEvidenceEdit[]>;
}

export class FsReviewEvidenceRepository implements FsReviewEvidenceSource {
  constructor(
    private readonly directory: FsSessionDirectory,
    private readonly snapshots: FsSessionSnapshotRepository,
  ) {}

  async listReviewEvidenceToolCalls(
    sessionId: SessionId | string,
    limit = 200,
  ): Promise<FsReviewEvidenceToolCall[]> {
    const entry = await this.directory.requireEntry(sessionId);
    const projection = projectConversation(
      this.directory.repository.readConversationSync(entry.location),
    );
    const artifacts = new ArtifactStore({
      bundlePath: entry.location.bundle_path,
      sessionId: entry.session.id,
    });
    return projection.toolCalls
      .filter(
        (call) =>
          call.tool_name === 'exec_command' ||
          call.tool_name === 'run_command' ||
          call.tool_name === 'shell_command',
      )
      .sort((left, right) =>
        right.output.created_at.localeCompare(left.output.created_at),
      )
      .slice(0, Math.max(0, limit))
      .map((call) => {
        const selected = call.output.shaped ?? call.output.raw;
        return {
          args_json: JSON.stringify(call.args),
          result_text: selected
            ? Buffer.from(artifacts.read(selected)).toString('utf8')
            : null,
          is_error: call.is_error ? 1 : 0,
          created_at: call.output.created_at,
        };
      });
  }

  async listReviewEvidenceEdits(
    sessionId: SessionId | string,
  ): Promise<FsReviewEvidenceEdit[]> {
    const entry = await this.directory.requireEntry(sessionId);
    const kind = entry.session.kind === 'company' ? 'company' : 'coder';
    const baselines = await this.snapshots.listBaselines(
      kind,
      entry.session.id,
      { includeClosed: true },
    );
    const edits = await Promise.all(
      baselines.map(async (baseline) =>
        (await this.snapshots.listEdits(baseline.id)).map((edit) => ({
          file_path: baseline.file_path,
          applied_at: edit.applied_at,
        })),
      ),
    );
    return edits
      .flat()
      .sort((left, right) => left.applied_at.localeCompare(right.applied_at));
  }
}
