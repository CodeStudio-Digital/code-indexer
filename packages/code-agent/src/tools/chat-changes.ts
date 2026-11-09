import { err, ok, type CoderTool } from '../core/tool.js';
import { okStructured } from '../core/model-output.js';
import { integrateUltraWorkspace, archiveIntegratedWorkspace, type UltraWorkspace } from '../runtime/ultra-workspace.js';
import type { ChatCheckpoint } from './chat-resume.js';

export const chatChangesTools: CoderTool[] = (['read_chat_changes', 'integrate_chat_changes'] as const).map(name => ({
  name, source: 'native', mutates: name === 'integrate_chat_changes', riskLevel: name === 'integrate_chat_changes' ? 'write' : 'read',
  effectBoundary: name === 'integrate_chat_changes' ? 'filesystem' : 'control', parallelSafe: false,
  description: name === 'read_chat_changes'
    ? 'Review the isolated changes produced by an owned implementation chat before integrating. Returns changed files and a bounded diff.'
    : 'Integrate reviewed child changes into this workspace. Refuses files changed since delegation and preserves snapshots. Run relevant checks after integration. Only the owning coordinator may integrate.',
  parameters: { type: 'object', properties: { chat_id: { type: 'string' } }, required: ['chat_id'], additionalProperties: false },
  handler: async (args, ctx) => {
    if (!ctx.collaboration) return err('No collaboration context');
    const { store, actor } = ctx.collaboration;
    try {
      const peer = await store.requireParticipant(String(args.chat_id));
      if (peer.parentId !== actor) return err('Only the owning coordinator can inspect or integrate this child');
      const workspace = await store.files.get<UltraWorkspace>('checkpoints', `workspace:${peer.id}`);
      if (!workspace) return err('This child has no isolated changes');
      if (name === 'read_chat_changes') return okStructured({ files: workspace.files, integrated: workspace.integrated,
        diff: workspace.diff.slice(0, 60_000), truncated: workspace.diff.length > 60_000, workspace: workspace.path });
      if (peer.state === 'running') return err('Wait until the child finishes before integrating');
      if (workspace.integrated) return ok('Changes were already integrated');
      const checkpoint = await store.files.get<ChatCheckpoint>('checkpoints', peer.id);
      if (checkpoint?.outcomeUnknown || !checkpoint?.workspaceReady) return err('Child changes have an uncertain or unfinished outcome; inspect and reconcile before integrating');
      await integrateUltraWorkspace(ctx, workspace);
      await store.files.put('checkpoints', `workspace:${peer.id}`, { ...workspace, integrated: true });
      // Cleanup failure must not turn a confirmed integration into an ambiguous retry.
      let retained = false;
      try { await archiveIntegratedWorkspace(workspace); } catch { retained = true; }
      return okStructured({ integrated: true, files: workspace.files, retainedCheckout: retained, next: 'Run relevant tests and review the resulting changes.' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ...err(message), ...(message.includes('outcome unknown') ? { effectOutcome: 'unknown' as const } : {}) };
    }
  },
}));
