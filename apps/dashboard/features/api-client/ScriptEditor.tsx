/**
 * Scripts tab — pre-request + test (post-response) JS editors with snippet
 * buttons. Scripts run server-side in a node:vm with the Postman `pm.*` API.
 * Persists on blur.
 */
import { Button } from '../../components/ui/button.js';
import { JsonRawEditor } from './body/JsonRawEditor.js';
import { PRE_SNIPPETS, TEST_SNIPPETS, type Snippet } from './script-snippets.js';
import type { ApiRequest } from './types.js';

interface Props {
  draft: ApiRequest;
  upd: (p: Partial<ApiRequest>) => void;
  persist: (p: Partial<ApiRequest>) => void;
}

export function ScriptEditor({ draft, upd, persist }: Props) {
  return (
    <div className="flex flex-col h-full gap-2">
      <Section
        title="Pre-request Script"
        value={draft.pre_request_script ?? ''}
        snippets={PRE_SNIPPETS}
        onChange={(v) => upd({ pre_request_script: v })}
        onBlur={() => persist({ pre_request_script: draft.pre_request_script })}
        onInsert={(code) => { const v = `${draft.pre_request_script ?? ''}${draft.pre_request_script ? '\n' : ''}${code}`; upd({ pre_request_script: v }); persist({ pre_request_script: v }); }}
      />
      <Section
        title="Tests"
        value={draft.test_script ?? ''}
        snippets={TEST_SNIPPETS}
        onChange={(v) => upd({ test_script: v })}
        onBlur={() => persist({ test_script: draft.test_script })}
        onInsert={(code) => { const v = `${draft.test_script ?? ''}${draft.test_script ? '\n' : ''}${code}`; upd({ test_script: v }); persist({ test_script: v }); }}
      />
    </div>
  );
}

function Section({ title, value, snippets, onChange, onBlur, onInsert }: {
  title: string; value: string; snippets: Snippet[];
  onChange: (v: string) => void; onBlur: () => void; onInsert: (code: string) => void;
}) {
  return (
    <div className="flex flex-col flex-1 min-h-0 gap-1">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] font-medium text-muted-foreground">{title}</span>
        {snippets.map((s) => (
          <Button key={s.label} type="button" variant="ghost" size="sm" className="h-5 px-1.5 text-[10px] text-muted-foreground" onClick={() => onInsert(s.code)}>
            + {s.label}
          </Button>
        ))}
      </div>
      <div className="flex-1 min-h-0">
        <JsonRawEditor value={value} language="javascript" showFormat={false} onChange={onChange} onBlur={onBlur} />
      </div>
    </div>
  );
}
