/**
 * Painel de diff side-by-side do Local History (estilo IntelliJ/WebStorm): versão
 * selecionada à esquerda, disco atual à direita, com números de linha, barras na
 * gutter, destaque intra-linha e cores de sintaxe. Carregado lazy via
 * LazyHistoryDiff. Usa o monaco bundlado localmente (setupMonaco), read-only.
 */
import { useEffect, useState } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import { Loader2 } from 'lucide-react';
import { setupMonaco } from '../../../lib/monaco-setup.js';
import { normalizeForDiff } from './line-diff.js';
import type { HistoryDiffProps } from './LazyHistoryDiff.js';

setupMonaco();

/** Tema do Monaco acompanhando a classe `dark` do documento (reativo). */
function useMonacoTheme(): 'vs-dark' | 'light' {
  const read = (): 'vs-dark' | 'light' =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark') ? 'vs-dark' : 'light';
  const [theme, setTheme] = useState<'vs-dark' | 'light'>(read);
  useEffect(() => {
    const el = document.documentElement;
    const obs = new MutationObserver(() => setTheme(read()));
    obs.observe(el, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  return theme;
}

export default function HistoryDiffImpl({ original, modified, language }: HistoryDiffProps) {
  const theme = useMonacoTheme();
  return (
    <DiffEditor
      height="100%"
      language={language}
      original={normalizeForDiff(original)}
      modified={normalizeForDiff(modified)}
      theme={theme}
      loading={
        <div className="h-full flex items-center justify-center">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      }
      options={{
        readOnly: true,
        renderSideBySide: true,
        minimap: { enabled: false },
        lineNumbers: 'on',
        glyphMargin: true,
        fontSize: 12,
        automaticLayout: true,
        scrollBeyondLastLine: false,
        wordWrap: 'off',
        renderOverviewRuler: false,
        ignoreTrimWhitespace: false,
      }}
    />
  );
}
