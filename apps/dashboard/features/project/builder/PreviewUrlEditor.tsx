/**
 * URL do preview na toolbar — clicável para editar. Enter/blur salva como
 * override manual do projeto (persistido via useProjectDevServer/localStorage,
 * vence a detecção automática); Esc cancela; o chip "URL manual" limpa o
 * override e volta à detecção. Aceita formas curtas: `3000` e
 * `localhost:3000` viram `http://localhost:3000`.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pin } from 'lucide-react';

function normalizeUrl(raw: string): string {
  const v = raw.trim();
  if (!v) return '';
  if (/^\d+$/.test(v)) return `http://localhost:${v}`;
  if (!/^https?:\/\//i.test(v)) return `http://${v}`;
  return v;
}

export function PreviewUrlEditor({
  url,
  manualUrl,
  onSet,
}: {
  /** URL efetiva exibida (manual > pinada > detectada). */
  url: string | null;
  /** Override manual ativo ('' quando a URL vem de detecção/porta pinada). */
  manualUrl: string;
  /** Persiste o override ('' limpa e volta à detecção). */
  onSet: (url: string) => void;
}) {
  const { t } = useTranslation('projects');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  function open() {
    setDraft(url ?? '');
    setEditing(true);
  }
  function commit() {
    setEditing(false);
    const next = normalizeUrl(draft);
    // Sem mudança → não cria override desnecessário sobre a URL detectada.
    if (next === (url ?? '')) return;
    onSet(next);
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') setEditing(false);
        }}
        placeholder={t('preview.urlPlaceholder')}
        className="flex-1 min-w-0 rounded border bg-background px-1.5 py-0.5 font-mono text-xs"
      />
    );
  }

  return (
    <>
      <button
        onClick={open}
        title={t('preview.urlEditTitle')}
        className="flex-1 min-w-0 truncate rounded px-1 text-left font-mono text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        {url ?? t('preview.noServerEditHint')}
      </button>
      {manualUrl && (
        <button
          onClick={() => onSet('')}
          className="inline-flex items-center gap-1 rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-800 hover:bg-amber-100"
          title={t('preview.manualUrlTitle')}
        >
          <Pin className="h-3 w-3" /> {t('preview.manualUrlChip')}
        </button>
      )}
    </>
  );
}
