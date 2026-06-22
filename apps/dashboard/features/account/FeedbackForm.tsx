/** Quick feedback (bug / idea / other). Reached only while signed in, so the
 *  server attributes + rate-limits it per account (20/day); on top we add a short
 *  client-side cooldown (survives modal reopen) to blunt accidental spam. The
 *  free-text is re-redacted server-side before storage. */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select.js';
import { cloudCall } from '../../lib/cloud/cloud-client.js';
import { useCloudAction } from '../../lib/cloud/use-cloud-action.js';

type Kind = 'bug' | 'idea' | 'other';
const COOLDOWN_MS = 30_000;
let lastSubmitAt = 0; // module-scope → survives the modal unmount/remount

export function FeedbackForm() {
  const { t } = useTranslation('cloud');
  const { busy, error, run } = useCloudAction();
  const [kind, setKind] = useState<Kind>('bug');
  const [message, setMessage] = useState('');
  const [sent, setSent] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (sent) return <p className="text-sm text-muted-foreground">{t('feedback.sent')}</p>;

  const cooldownLeft = Math.max(0, Math.ceil((lastSubmitAt + COOLDOWN_MS - now) / 1000));

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (cooldownLeft > 0) return;
        void run(async () => {
          await cloudCall('feedback.submit', { kind, message });
          lastSubmitAt = Date.now();
          setSent(true);
        });
      }}
      className="space-y-2"
    >
      <Select value={kind} onValueChange={(v) => setKind(v as Kind)}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="bug">{t('feedback.kind.bug')}</SelectItem>
          <SelectItem value="idea">{t('feedback.kind.idea')}</SelectItem>
          <SelectItem value="other">{t('feedback.kind.other')}</SelectItem>
        </SelectContent>
      </Select>
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder={t('feedback.message')}
        rows={4}
        className="w-full rounded-md border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      />
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {cooldownLeft > 0 ? <p className="text-xs text-muted-foreground">{t('feedback.cooldown', { seconds: cooldownLeft })}</p> : null}
      <Button type="submit" size="sm" disabled={busy || !message.trim() || cooldownLeft > 0}>
        {t('feedback.submit')}
      </Button>
    </form>
  );
}
