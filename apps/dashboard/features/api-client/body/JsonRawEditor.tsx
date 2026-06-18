/**
 * JSON / raw / graphql body editor — a lazy Monaco surface with a Format button.
 * Controlled: value in, onChange out, onBlur persists.
 */
import { useRef } from 'react';
import type { editor } from 'monaco-editor';
import { Wand2 } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { LazyMonaco } from '../LazyMonaco.js';
import { useLatest } from '../use-latest.js';

interface Props {
  value: string;
  language: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  showFormat?: boolean;
}

// Monaco bogs down on multi-MB content; a huge pasted body falls back to a plain
// textarea (cheap, still editable).
const HEAVY_BYTES = 1024 * 1024;

export function JsonRawEditor({ value, language, onChange, onBlur, showFormat = true }: Props) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  // The blur listener is registered once in onMount; route it through a ref so it
  // always calls the LATEST onBlur (which closes over the current draft) — else
  // it persists the draft captured at first mount and silently loses edits.
  const onBlurRef = useLatest(onBlur);

  const format = () => editorRef.current?.getAction('editor.action.formatDocument')?.run();

  if (value.length > HEAVY_BYTES) {
    return (
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => onBlur?.()}
        spellCheck={false}
        className="flex-1 min-h-0 w-full border rounded p-2 font-mono text-xs resize-none bg-background"
      />
    );
  }

  return (
    <div className="flex flex-col h-full gap-1">
      {showFormat && (
        <div className="flex justify-end">
          <Button type="button" variant="ghost" size="sm" className="h-6 gap-1 text-[11px] text-muted-foreground" onClick={format}>
            <Wand2 className="h-3 w-3" /> Format
          </Button>
        </div>
      )}
      <div className="flex-1 min-h-0 border rounded overflow-hidden">
        <LazyMonaco
          value={value}
          language={language}
          onChange={onChange}
          onMount={(ed) => {
            editorRef.current = ed;
            ed.onDidBlurEditorText(() => onBlurRef.current?.());
          }}
        />
      </div>
    </div>
  );
}
