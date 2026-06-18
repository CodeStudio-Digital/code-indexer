/**
 * "Reload from disk" — relê o conteúdo do disco e substitui o buffer (descarta
 * edições não salvas), via o patcher do modelo vivo (preserva o undo stack).
 * Usado pelo banner de mudança externa e pelo menu da aba.
 */
import { apiCall } from '../../../lib/api-client.js';
import { toast } from '../../../components/ui/prompt-dialog.js';
import { applyExternalContent } from './editor-models.js';

export async function reloadFromDisk(projectId: number, path: string): Promise<void> {
  try {
    const res = await apiCall<
      { content: string; last_modified: string } | { notModified: true; last_modified: string }
    >('files.read', { projectId, path });
    if ('content' in res) applyExternalContent(projectId, path, res.content, res.last_modified);
  } catch (e) {
    toast.error('Reload failed', { description: e instanceof Error ? e.message : String(e) });
  }
}
