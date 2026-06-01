import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen, Loader2 } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { installSkillFromLocal, type InstallFromGithubResult } from './skills-api.js';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInstalled: () => void;
}

export function SkillsInstallLocalDialog({ open, onOpenChange, onInstalled }: Props) {
  const { t } = useTranslation('admin');
  const [folderPath, setFolderPath] = useState('');
  const [namespace, setNamespace] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<InstallFromGithubResult | null>(null);

  const reset = () => {
    setError(null);
    setResult(null);
    setBusy(false);
  };

  const handleInstall = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await installSkillFromLocal({
        folderPath: folderPath.trim(),
        namespace: namespace.trim() || undefined,
        overwrite,
      });
      setResult(r);
      onInstalled();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderOpen className="h-4 w-4" />
            {t('skillsInstall.local.title')}
          </DialogTitle>
          <DialogDescription>
            {t('skillsInstall.local.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <label className="text-xs font-medium">{t('skillsInstall.folderPath')}</label>
            <Input
              placeholder="C:\Users\...\my-skills"
              value={folderPath}
              onChange={(e) => setFolderPath(e.target.value)}
              disabled={busy}
              className="font-mono text-sm"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">{t('skillsInstall.namespace')}</label>
            <Input
              placeholder={t('skillsInstall.namespaceFolderPlaceholder')}
              value={namespace}
              onChange={(e) => setNamespace(e.target.value)}
              disabled={busy}
            />
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={overwrite}
              onChange={(e) => setOverwrite(e.target.checked)}
              disabled={busy}
            />
            {t('skillsInstall.overwrite')}
          </label>

          {error && (
            <div className="text-xs text-red-600 bg-red-50 dark:bg-red-950/30 rounded p-2">
              {error}
            </div>
          )}

          {result && (
            <div className="text-xs border rounded p-2 space-y-1">
              <div className="font-medium">
                {t('skillsInstall.installed', { count: result.installed.length })}{' '}
                <Badge variant="secondary">{result.namespace}</Badge>
              </div>
              <div className="text-muted-foreground font-mono text-[11px] break-all">
                {folderPath}
              </div>
              <ul className="max-h-32 overflow-auto space-y-0.5">
                {result.installed.map((i) => (
                  <li key={i.id} className="flex items-center gap-1.5">
                    <Badge variant="outline" className="text-[10px]">
                      {i.kind}
                    </Badge>
                    <span className="font-mono text-[11px]">
                      {i.slash_command ? `/${i.slash_command}` : i.name}
                    </span>
                  </li>
                ))}
              </ul>

              {result.mcpServers && result.mcpServers.length > 0 && (
                <div className="pt-2 border-t mt-2 space-y-1">
                  <div className="font-medium">
                    {t('skillsInstall.mcpServers', { count: result.mcpServers.length })}
                  </div>
                  <ul className="max-h-24 overflow-auto space-y-0.5">
                    {result.mcpServers.map((s) => (
                      <li key={s.id} className="flex items-center gap-1.5">
                        <Badge variant="outline" className="text-[10px]">
                          {s.transport}
                        </Badge>
                        <span className="font-mono text-[11px]">{s.name}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="text-[10px] text-muted-foreground">
                    {t('skillsInstall.httpWarning')}
                  </div>
                </div>
              )}

              {result.warnings && result.warnings.length > 0 && (
                <div className="pt-2 border-t mt-2 text-[10px] text-amber-600 dark:text-amber-400 space-y-0.5">
                  {result.warnings.map((w, idx) => (
                    <div key={idx}>⚠ {w}</div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            {t('skillsInstall.close')}
          </Button>
          <Button onClick={handleInstall} disabled={busy || !folderPath.trim()}>
            {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {t('skillsInstall.install')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
