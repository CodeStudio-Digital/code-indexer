/**
 * Strip de ações do processo de design — 5 botões de etapa (Análise →
 * Tokens → Primitivos → Compostos → Docs) acima do chat do DS Studio.
 * Cada clique injeta um prompt especializado no composer via
 * `requestStudioSend` (mesmo mecanismo do botão Publicar): o usuário vê a
 * mensagem no chat e mantém o humano-no-loop. Stateless de propósito — o
 * estado real do progresso é o próprio workspace (brief escrito? tokens
 * reescritos? galeria populada?).
 */
import { useTranslation } from 'react-i18next';
import { FileSearch, Palette, Shapes, Boxes, BookOpenText } from 'lucide-react';
import { requestStudioSend } from '../../builder/studio/studio-context-store.js';

const STAGES = [
  { key: 'analyze', Icon: FileSearch },
  { key: 'tokens', Icon: Palette },
  { key: 'primitives', Icon: Shapes },
  { key: 'composites', Icon: Boxes },
  { key: 'docs', Icon: BookOpenText },
] as const;

export function DsStudioActions({ projectId }: { projectId: number }) {
  const { t } = useTranslation('designSystems');
  return (
    <div
      role="toolbar"
      aria-label={t('studio.actionsAria')}
      className="flex shrink-0 items-center gap-1 overflow-x-auto border-b px-2 py-1.5"
    >
      {STAGES.map(({ key, Icon }) => (
        <button
          key={key}
          onClick={() => requestStudioSend(projectId, t(`studio.stageMessage.${key}`))}
          title={t(`studio.stageMessage.${key}`)}
          className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded border px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
        >
          <Icon className="h-3.5 w-3.5" />
          {t(`studio.stage.${key}`)}
        </button>
      ))}
    </div>
  );
}
