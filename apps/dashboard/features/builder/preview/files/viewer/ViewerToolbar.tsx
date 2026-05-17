import React, { useState } from 'react';
import { Check, Copy, Hash, WrapText, FileText, Code2 } from 'lucide-react';
import type { ViewerPrefs } from './useViewerPrefs.js';

interface Props {
  code: string;
  prefs: ViewerPrefs;
  setPrefs: (patch: Partial<ViewerPrefs>) => void;
  markdownCapable: boolean;
}

export function ViewerToolbar({ code, prefs, setPrefs, markdownCapable }: Props) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — nothing to do */
    }
  }

  return (
    <div className="h-8 flex items-center gap-1 px-2 border-b bg-muted/10 shrink-0">
      <ToggleIcon
        active={prefs.lineNumbers}
        onClick={() => setPrefs({ lineNumbers: !prefs.lineNumbers })}
        title="Números de linha"
        icon={Hash}
      />
      <ToggleIcon
        active={prefs.wrap}
        onClick={() => setPrefs({ wrap: !prefs.wrap })}
        title="Quebrar linhas longas"
        icon={WrapText}
      />
      {markdownCapable && (
        <ToggleIcon
          active={prefs.renderMarkdown}
          onClick={() => setPrefs({ renderMarkdown: !prefs.renderMarkdown })}
          title={prefs.renderMarkdown ? 'Ver código-fonte Markdown' : 'Renderizar Markdown'}
          icon={prefs.renderMarkdown ? Code2 : FileText}
        />
      )}
      <div className="flex-1" />
      <button
        type="button"
        onClick={handleCopy}
        className="flex items-center gap-1 px-1.5 py-1 rounded-md hover:bg-muted text-[11px] text-muted-foreground"
        title="Copiar conteúdo"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
        {copied ? 'Copiado' : 'Copiar'}
      </button>
    </div>
  );
}

function ToggleIcon({
  active,
  onClick,
  title,
  icon: Icon,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={
        'p-1 rounded-md hover:bg-muted ' +
        (active ? 'bg-muted text-foreground' : 'text-muted-foreground')
      }
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}
