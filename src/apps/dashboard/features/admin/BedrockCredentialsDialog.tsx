import { useState } from 'react';
import { Button } from '../../components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';

interface BedrockCredentialsDialogProps {
  onClose: () => void;
  onSaved: () => void;
}

export function BedrockCredentialsDialog({ onClose, onSaved }: BedrockCredentialsDialogProps) {
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [sessionToken, setSessionToken] = useState('');
  const [region, setRegion] = useState('us-east-1');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch('/api/admin/oauth/bedrock/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          access_key_id: accessKeyId,
          secret_access_key: secretAccessKey,
          session_token: sessionToken || undefined,
          region,
        }),
      });
      if (!r.ok) {
        const j = (await r.json()) as { error?: string };
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>AWS Bedrock credentials</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <p className="text-xs text-muted-foreground">
            Stored locally in the SQLite admin database. Used by the Bedrock coder adapter and model
            discovery.
          </p>
          <div>
            <label className="text-xs font-medium">Access Key ID</label>
            <Input value={accessKeyId} onChange={(e) => setAccessKeyId(e.target.value)} placeholder="AKIA…" />
          </div>
          <div>
            <label className="text-xs font-medium">Secret Access Key</label>
            <Input
              type="password"
              value={secretAccessKey}
              onChange={(e) => setSecretAccessKey(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs font-medium">Session Token (optional, for STS)</label>
            <Input type="password" value={sessionToken} onChange={(e) => setSessionToken(e.target.value)} />
          </div>
          <div>
            <label className="text-xs font-medium">Region</label>
            <Input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="us-east-1" />
          </div>
          {error && <div className="text-xs text-red-600 break-all">{error}</div>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving || !accessKeyId || !secretAccessKey || !region}>
            {saving ? 'Saving…' : 'Save credentials'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
