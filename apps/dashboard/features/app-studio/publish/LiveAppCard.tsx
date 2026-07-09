/**
 * Celebração: "Seu app está no ar!" — URL grande, copiar e abrir.
 * (QR code para abrir no celular: polish futuro — exige dep `qrcode`.)
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, ExternalLink, PartyPopper } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';

export function LiveAppCard({ url }: { url: string }) {
  const { t } = useTranslation('appStudio');
  const [copied, setCopied] = useState(false);

  function copy() {
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="space-y-3 rounded-lg border border-green-500/40 bg-green-500/5 p-4 text-center">
      <PartyPopper className="mx-auto h-8 w-8 text-green-600" />
      <p className="text-sm font-semibold">{t('publish.live.title', { defaultValue: 'Seu app está no ar!' })}</p>
      <p className="truncate rounded border bg-background px-2 py-1.5 font-mono text-sm">{url.replace(/^https?:\/\//, '')}</p>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" className="flex-1" onClick={copy}>
          {copied ? <Check className="mr-1 h-3.5 w-3.5 text-green-600" /> : <Copy className="mr-1 h-3.5 w-3.5" />}
          {t('publish.live.copy', { defaultValue: 'Copiar' })}
        </Button>
        <Button size="sm" className="flex-1" onClick={() => window.open(url, '_blank', 'noopener')}>
          <ExternalLink className="mr-1 h-3.5 w-3.5" /> {t('publish.live.open', { defaultValue: 'Abrir' })}
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {t('publish.live.share', { defaultValue: 'Compartilhe o endereço — funciona em qualquer celular ou computador.' })}
      </p>
    </div>
  );
}
