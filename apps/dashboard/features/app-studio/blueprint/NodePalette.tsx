/**
 * Palette do Blueprint — adiciona nós com um clique: Tela, Dados, Recurso,
 * Ação (behavior) e Login. Pergunta só o nome (prompt) e cria com defaults
 * seguros; o refinamento acontece no inspector.
 */
import { useTranslation } from 'react-i18next';
import { Database, KeyRound, Layout, Puzzle, Zap, type LucideIcon } from 'lucide-react';
import type { AppSpec } from '@mcp/app-studio/spec/types.js';
import type { BlueprintMutation } from '@mcp/app-studio/blueprint/mutations.js';
import { prompt } from '../../../components/ui/prompt-dialog.js';
import { Button } from '../../../components/ui/button.js';

export function NodePalette({
  spec,
  onMutate,
}: {
  spec: AppSpec;
  onMutate: (m: BlueprintMutation) => Promise<boolean>;
}) {
  const { t } = useTranslation('appStudio');

  async function ask(labelKey: string): Promise<string | null> {
    const value = await prompt({
      title: t(labelKey),
      placeholder: t('blueprint.palette.namePlaceholder'),
    });
    return value?.trim() || null;
  }

  const items: Array<{ key: string; icon: LucideIcon; run: () => Promise<void> }> = [
    {
      key: 'screen',
      icon: Layout,
      run: async () => {
        const label = await ask('blueprint.palette.addScreen');
        if (label) void onMutate({ op: 'add-screen', label });
      },
    },
    {
      key: 'entity',
      icon: Database,
      run: async () => {
        const label = await ask('blueprint.palette.addEntity');
        if (label) void onMutate({ op: 'add-entity', label });
      },
    },
    {
      key: 'feature',
      icon: Puzzle,
      run: async () => {
        const label = await ask('blueprint.palette.addFeature');
        if (label) void onMutate({ op: 'add-feature', name: label });
      },
    },
    {
      key: 'behavior',
      icon: Zap,
      run: async () => {
        const home = spec.screens.find((s) => s.primary) ?? spec.screens[0];
        if (!home) return;
        const label = await ask('blueprint.palette.addBehavior');
        if (label) {
          void onMutate({
            op: 'add-behavior',
            screen_id: home.id,
            trigger: 'click',
            trigger_label: label,
            action: { kind: 'notify', message: label },
          });
        }
      },
    },
    {
      key: 'auth',
      icon: KeyRound,
      run: async () => {
        void onMutate({ op: 'set-auth-enabled', enabled: !spec.auth.enabled });
      },
    },
  ];

  return (
    <div className="flex items-center gap-1">
      {items.map(({ key, icon: Icon, run }) => (
        <Button
          key={key}
          size="sm"
          variant="outline"
          className="h-7 px-2 text-xs"
          title={t(`blueprint.palette.${key}Hint`)}
          onClick={() => void run()}
        >
          <Icon className="mr-1 h-3 w-3" /> {t(`blueprint.kind.${key}`)}
        </Button>
      ))}
    </div>
  );
}
