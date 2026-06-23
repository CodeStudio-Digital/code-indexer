/**
 * Scripts tab — pre-request + test (post-response) JS editors with snippet
 * buttons + a focused AI helper (Ask AI) that writes pm.* scripts. Scripts run
 * server-side in a node:vm with the Postman `pm.*` API. Persists on blur.
 */
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button.js';
import { JsonRawEditor } from './body/JsonRawEditor.js';
import { AiScriptBar } from './ai/AiScriptBar.js';
import { PRE_SNIPPETS, TEST_SNIPPETS, type Snippet } from './script-snippets.js';
import type { ApiRequest } from './types.js';
import type { ScriptAssistPayload } from './api.js';

/** Maps a snippet label (stable, defined in script-snippets.ts) to its i18n key. */
const SNIPPET_LABEL_KEYS: Record<string, string> = {
  'Set env variable': 'snippetSetEnvVariable',
  'Set a header': 'snippetSetHeader',
  'Timestamp variable': 'snippetTimestampVariable',
  'Status is 200': 'snippetStatusIs200',
  'Body has property': 'snippetBodyHasProperty',
  'Save token from response': 'snippetSaveTokenFromResponse',
  'Response time < 500ms': 'snippetResponseTimeBelow500',
};

interface Props {
  draft: ApiRequest;
  upd: (p: Partial<ApiRequest>) => void;
  persist: (p: Partial<ApiRequest>) => void;
  responseShape?: string;
  onAssist?: (payload: ScriptAssistPayload) => Promise<{ script: string; explanation: string }>;
}

export function ScriptEditor({ draft, upd, persist, responseShape, onAssist }: Props) {
  const appendTo = (col: 'pre_request_script' | 'test_script') => (code: string) => {
    const cur = draft[col] ?? '';
    const v = `${cur}${cur ? '\n' : ''}${code}`;
    upd({ [col]: v } as Partial<ApiRequest>);
    persist({ [col]: v } as Partial<ApiRequest>);
  };

  return (
    <div className="flex flex-col h-full gap-2">
      <Section
        titleKey="preRequestScript" target="pre" snippets={PRE_SNIPPETS}
        value={draft.pre_request_script ?? ''}
        draft={draft} responseShape={responseShape} onAssist={onAssist}
        onChange={(v) => upd({ pre_request_script: v })}
        onBlur={() => persist({ pre_request_script: draft.pre_request_script })}
        onInsert={appendTo('pre_request_script')}
      />
      <Section
        titleKey="tests" target="test" snippets={TEST_SNIPPETS}
        value={draft.test_script ?? ''}
        draft={draft} responseShape={responseShape} onAssist={onAssist}
        onChange={(v) => upd({ test_script: v })}
        onBlur={() => persist({ test_script: draft.test_script })}
        onInsert={appendTo('test_script')}
      />
    </div>
  );
}

function Section({ titleKey, target, value, snippets, draft, responseShape, onAssist, onChange, onBlur, onInsert }: {
  titleKey: string; target: 'pre' | 'test'; value: string; snippets: Snippet[];
  draft: ApiRequest; responseShape?: string;
  onAssist?: (payload: ScriptAssistPayload) => Promise<{ script: string; explanation: string }>;
  onChange: (v: string) => void; onBlur: () => void; onInsert: (code: string) => void;
}) {
  const { t } = useTranslation('apiClient');
  return (
    <div className="flex flex-col flex-1 min-h-0 gap-1">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] font-medium text-muted-foreground">{t(`scripts.${titleKey}`)}</span>
        {snippets.map((s) => (
          <Button key={s.label} type="button" variant="ghost" size="sm" className="h-5 px-1.5 text-[10px] text-muted-foreground" onClick={() => onInsert(s.code)}>
            + {SNIPPET_LABEL_KEYS[s.label] ? t(`scripts.${SNIPPET_LABEL_KEYS[s.label]}`) : s.label}
          </Button>
        ))}
      </div>
      {onAssist && (
        <AiScriptBar target={target} request={draft} responseShape={responseShape} existing={value} onInsert={onInsert} onAssist={onAssist} />
      )}
      <div className="flex-1 min-h-0">
        <JsonRawEditor value={value} language="javascript" showFormat={false} onChange={onChange} onBlur={onBlur} />
      </div>
    </div>
  );
}
