/**
 * First-run experience — three-step wizard a user lands on the very
 * first time they open MCP IDE.
 *
 *   1. Welcome — brand mark, value props, "Get started" CTA.
 *   2. Provider — pick a provider (Anthropic / OpenAI / Google / …),
 *      paste an API key. Saved to the local providers store on next.
 *      Skippable (BYOK is the model — but every provider's `enabled`
 *      flag still has to be flipped at least once for chat to work).
 *   3. Project — either open an existing folder (electronAPI.openDirectory
 *      in Electron, manual path input in browser dev) or skip and
 *      create projects later from the home screen.
 *
 * Gating: only renders when localStorage `mcp-ide:onboarded` is not
 * already `'true'`. Completing step 3 sets the flag and the wizard
 * never reappears. The user can re-run it from Settings → Onboarding.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowRight,
  Check,
  ChevronLeft,
  FolderOpen,
  Key,
  Loader2,
  Sparkles,
} from 'lucide-react';
import { apiCall } from '../../lib/api-client.js';
import { toast } from '../../components/ui/prompt-dialog.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import { cn } from '../../lib/utils.js';
import { markOnboarded } from './storage.js';

type Step = 'welcome' | 'provider' | 'project';

interface OnboardingWizardProps {
  onComplete: () => void;
  /** Force-skip when there's already a project (returning user). */
  alreadyHasProjects?: boolean;
}

export function OnboardingWizard({ onComplete, alreadyHasProjects }: OnboardingWizardProps) {
  const [step, setStep] = useState<Step>('welcome');

  const finish = () => {
    markOnboarded();
    onComplete();
  };

  return (
    <div className="fixed inset-0 z-[60] bg-background/95 backdrop-blur-sm flex items-center justify-center">
      <div className="w-full max-w-2xl rounded-xl border bg-card shadow-2xl overflow-hidden">
        <StepIndicator step={step} />
        <div className="p-8 min-h-[420px] flex flex-col">
          {step === 'welcome' && <WelcomeStep onNext={() => setStep('provider')} />}
          {step === 'provider' && (
            <ProviderStep
              onBack={() => setStep('welcome')}
              onNext={() => setStep('project')}
            />
          )}
          {step === 'project' && (
            <ProjectStep
              onBack={() => setStep('provider')}
              onFinish={finish}
              alreadyHasProjects={alreadyHasProjects}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Step indicator (the chip row at the top) ──────────────────────

function StepIndicator({ step }: { step: Step }) {
  const { t } = useTranslation();
  const idx = step === 'welcome' ? 0 : step === 'provider' ? 1 : 2;
  const labels = [
    t('onboarding.steps.welcome'),
    t('onboarding.steps.provider'),
    t('onboarding.steps.project'),
  ];
  return (
    <div className="border-b bg-card/60 px-8 py-4 flex items-center gap-3">
      {labels.map((label, i) => {
        const done = i < idx;
        const current = i === idx;
        return (
          <div key={label} className="inline-flex items-center gap-2">
            <span
              className={cn(
                'h-5 w-5 rounded-full text-[10px] grid place-items-center font-semibold transition-colors',
                done && 'bg-primary text-primary-foreground',
                current && 'border-2 border-primary text-primary',
                !done && !current && 'border border-border text-muted-foreground',
              )}
            >
              {done ? <Check className="h-3 w-3" /> : i + 1}
            </span>
            <span
              className={cn(
                'text-[12px] font-medium',
                current && 'text-foreground',
                !current && 'text-muted-foreground',
              )}
            >
              {label}
            </span>
            {i < labels.length - 1 && (
              <span className="w-6 h-px bg-border" aria-hidden />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Step 1: Welcome ──────────────────────────────────────────────

function WelcomeStep({ onNext }: { onNext: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center gap-6">
      <div className="h-16 w-16 rounded-2xl bg-primary/10 grid place-items-center">
        <Sparkles className="h-8 w-8 text-primary" />
      </div>
      <div className="space-y-2 max-w-md">
        <h1 className="text-2xl font-semibold tracking-tight">{t('onboarding.welcome.title')}</h1>
        <p className="text-[13px] text-muted-foreground leading-relaxed">
          {t('onboarding.welcome.description')}
        </p>
      </div>
      <div className="grid grid-cols-3 gap-3 text-left w-full max-w-lg">
        <Highlight title={t('onboarding.welcome.keys.title')} body={t('onboarding.welcome.keys.body')} />
        <Highlight title={t('onboarding.welcome.local.title')} body={t('onboarding.welcome.local.body')} />
        <Highlight title={t('onboarding.welcome.free.title')} body={t('onboarding.welcome.free.body')} />
      </div>
      <Button size="lg" onClick={onNext} className="mt-2">
        {t('onboarding.welcome.cta')}
        <ArrowRight className="h-4 w-4" />
      </Button>
    </div>
  );
}

function Highlight({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border bg-card/40 p-3 space-y-1">
      <div className="text-[12px] font-semibold text-foreground">{title}</div>
      <div className="text-[11px] text-muted-foreground leading-snug">{body}</div>
    </div>
  );
}

// ─── Step 2: Provider ─────────────────────────────────────────────

interface ProviderOption {
  id: string;
  label: string;
  /** Hint shown under the input. */
  keyExample?: string;
  /** Default model suggestion (used only to surface a recommendation). */
  defaultModel?: string;
}

const PROVIDERS: ProviderOption[] = [
  { id: 'anthropic', label: 'Anthropic',     keyExample: 'sk-ant-…',  defaultModel: 'claude-sonnet-5' },
  { id: 'openai',    label: 'OpenAI',        keyExample: 'sk-…',      defaultModel: 'gpt-5' },
  { id: 'google',    label: 'Google AI',     keyExample: 'AIza…',     defaultModel: 'gemini-2.5-pro' },
  { id: 'bedrock',   label: 'AWS Bedrock',   keyExample: 'IAM access keys configured separately' },
];

function ProviderStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const { t } = useTranslation();
  const [providerId, setProviderId] = useState('anthropic');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const provider = PROVIDERS.find((p) => p.id === providerId) ?? PROVIDERS[0];

  const submit = async () => {
    if (!apiKey.trim()) {
      // Allow skip-with-no-key, but warn so the user knows chat won't work
      // until they add one in Settings.
      toast.message(t('onboarding.provider.skipToast.title'), {
        description: t('onboarding.provider.skipToast.description'),
      });
      onNext();
      return;
    }
    setSaving(true);
    try {
      // admin.providers.update is the canonical "save+enable provider"
      // call. The handler accepts {id, api_key, enabled} and is wired
      // by the route dispatch bridge in handlers-mount.
      await apiCall('admin.providers.update', {
        id: providerId,
        api_key: apiKey.trim(),
        enabled: true,
      });
      toast.success(t('onboarding.provider.connected.title'), {
        description: t('onboarding.provider.connected.description', { provider: provider.label }),
      });
      onNext();
    } catch (e) {
      toast.error(t('onboarding.provider.saveFailed'), {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-lg bg-primary/10 grid place-items-center">
          <Key className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h2 className="text-lg font-semibold">{t('onboarding.provider.title')}</h2>
          <p className="text-[12px] text-muted-foreground">
            {t('onboarding.provider.description')}
          </p>
        </div>
      </div>

      <div className="space-y-3">
        <div className="space-y-1.5">
          <label className="text-[12px] font-medium text-muted-foreground">{t('onboarding.provider.provider')}</label>
          <Select value={providerId} onValueChange={setProviderId}>
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROVIDERS.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <label className="text-[12px] font-medium text-muted-foreground">{t('onboarding.provider.apiKey')}</label>
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={provider.keyExample ?? t('onboarding.provider.keyPlaceholder')}
            autoComplete="off"
            spellCheck={false}
          />
          {provider.defaultModel && (
            <p className="text-[10.5px] text-muted-foreground">
              {t('onboarding.provider.defaultModel')} <span className="font-mono">{provider.defaultModel}</span> — {t('onboarding.provider.switchSettings')}
            </p>
          )}
        </div>
      </div>

      <div className="rounded-md border bg-muted/30 p-3 text-[11px] text-muted-foreground leading-snug">
        {t('onboarding.provider.noKeyHelp')}
      </div>

      <div className="mt-auto flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ChevronLeft className="h-3.5 w-3.5" />
          {t('onboarding.back')}
        </Button>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onNext} disabled={saving}>
            {t('onboarding.skip')}
          </Button>
          <Button size="sm" onClick={submit} disabled={saving || !apiKey.trim()}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            {t('onboarding.connectContinue')}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Step 3: Project ──────────────────────────────────────────────

function ProjectStep({
  onBack,
  onFinish,
  alreadyHasProjects,
}: {
  onBack: () => void;
  onFinish: () => void;
  alreadyHasProjects?: boolean;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [projectPath, setProjectPath] = useState('');
  const [projectName, setProjectName] = useState('');
  const [creating, setCreating] = useState(false);
  const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

  // When the user picks a directory, default the project name to its basename.
  useEffect(() => {
    if (!projectPath) return;
    if (projectName) return;
    const base = projectPath.split(/[/\\]/).filter(Boolean).pop() ?? '';
    if (base) setProjectName(base);
  }, [projectPath, projectName]);

  const pickDirectory = async () => {
    if (!isElectron || !window.electronAPI?.openDirectory) {
      toast.message(t('onboarding.project.pickToast.title'), {
        description: t('onboarding.project.pickToast.description'),
      });
      return;
    }
    try {
      const dir = await window.electronAPI.openDirectory();
      if (dir) setProjectPath(dir);
    } catch (e) {
      toast.error(t('onboarding.project.pickerFailed'), {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const create = async () => {
    if (!projectPath.trim() || !projectName.trim()) return;
    setCreating(true);
    try {
      const project = await apiCall<{ id: number }>('projects.create', {
        name: projectName.trim(),
        root_path: projectPath.trim(),
      });
      onFinish();
      navigate(`/projects/${project.id}`);
    } catch (e) {
      toast.error(t('onboarding.project.createFailed'), {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-lg bg-primary/10 grid place-items-center">
          <FolderOpen className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h2 className="text-lg font-semibold">
            {alreadyHasProjects ? t('onboarding.project.titleExisting') : t('onboarding.project.titleFirst')}
          </h2>
          <p className="text-[12px] text-muted-foreground">
            {t('onboarding.project.description')}
          </p>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-end gap-2">
          <div className="flex-1 space-y-1.5">
            <label className="text-[12px] font-medium text-muted-foreground">{t('onboarding.project.folder')}</label>
            <Input
              value={projectPath}
              onChange={(e) => setProjectPath(e.target.value)}
              placeholder={isElectron ? 'D:\\Projects\\my-app' : 'C:/path/to/project'}
              spellCheck={false}
            />
          </div>
          <Button variant="outline" onClick={pickDirectory} className="shrink-0 h-9">
            <FolderOpen className="h-3.5 w-3.5" />
            {t('onboarding.project.browse')}
          </Button>
        </div>

        <div className="space-y-1.5">
          <label className="text-[12px] font-medium text-muted-foreground">{t('onboarding.project.name')}</label>
          <Input
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            placeholder="my-app"
            spellCheck={false}
          />
        </div>
      </div>

      <div className="rounded-md border bg-muted/30 p-3 text-[11px] text-muted-foreground leading-snug">
        {t('onboarding.project.indexingHelp')}
      </div>

      <div className="mt-auto flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ChevronLeft className="h-3.5 w-3.5" />
          {t('onboarding.back')}
        </Button>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onFinish}>
            {alreadyHasProjects ? t('onboarding.project.pickLater') : t('onboarding.skip')}
          </Button>
          <Button
            size="sm"
            onClick={create}
            disabled={creating || !projectPath.trim() || !projectName.trim()}
          >
            {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            {t('onboarding.project.open')}
          </Button>
        </div>
      </div>
    </div>
  );
}
