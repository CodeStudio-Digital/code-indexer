/** Podman assistant: a scoped chat over `mcp.assistant`, streaming text + tool
 *  status into the log. Uses small local `.pod-chat-*` styles for the bubbles. */
import { button, clear, div, el, mcp } from '@mcp/plugin-sdk/ui';
import type { AssistantChunk } from '@mcp/plugin-sdk/ui';
import type { Translate } from './i18n.js';

export function renderAssistant(host: HTMLElement, t: Translate): void {
  clear(host);
  if (!mcp.assistant || !mcp.assistant.chat) {
    host.appendChild(div('mcp-state', el('div', 'mcp-state-msg', t('assistant.unavailable'))));
    return;
  }

  const wrap = div('pod-chat');
  const modelSel = el('select', 'mcp-select pod-chat-models');
  modelSel.appendChild(option('', t('assistant.loadingModels')));
  const log = div('pod-chat-log');
  log.appendChild(el('div', 'mcp-muted', t('assistant.intro')));
  const ask = el('textarea', 'mcp-textarea pod-chat-ask');
  ask.rows = 1;
  ask.placeholder = t('assistant.placeholder');
  const send = button(t('assistant.send'), 'primary sm', () => go());
  wrap.append(div('pod-chat-bar', modelSel), log, div('pod-chat-input', ask, send));
  host.appendChild(wrap);

  let closeChat: (() => void) | null = null;
  const history: Array<{ role: string; text: string }> = [];
  let started = false;
  let toolStrip: HTMLElement | null = null;

  const startLog = () => {
    if (!started) {
      log.innerHTML = '';
      started = true;
    }
  };
  const bubble = (cls: string) => {
    startLog();
    toolStrip = null;
    const b = el('div', `pod-bubble ${cls}`);
    log.appendChild(b);
    log.scrollTop = log.scrollHeight;
    return b;
  };
  const toolLine = (name: string) => {
    startLog();
    if (!toolStrip) {
      toolStrip = div('pod-tools');
      log.appendChild(toolStrip);
    }
    const line = el('div', 'pod-tool run', t('assistant.running', { name }));
    toolStrip.appendChild(line);
    log.scrollTop = log.scrollHeight;
    return line;
  };

  mcp.assistant
    .listModels()
    .then((models) => {
      clear(modelSel);
      if (!models?.length) return modelSel.appendChild(option('', t('assistant.noModels')));
      for (const m of models) {
        const o = option(`${m.providerId}|${m.modelId}`, m.label + (m.isDefault ? ' *' : ''));
        if (m.isDefault) o.selected = true;
        modelSel.appendChild(o);
      }
    })
    .catch(() => modelSel.appendChild(option('', t('assistant.noModels'))));

  function go(): void {
    const msg = ask.value.trim();
    if (!msg || closeChat) return;
    ask.value = '';
    const userB = bubble('user');
    userB.textContent = msg;
    const sel = (modelSel.value || '').split('|');
    let text = '';
    let botB: HTMLElement | null = null;
    const pending: Record<string, HTMLElement> = {};
    send.disabled = true;

    closeChat = mcp.assistant.chat(
      msg,
      { providerId: sel[0] || undefined, modelId: sel[1] || undefined, history: history.slice() },
      {
        onData: (c: AssistantChunk) => onChunk(c),
        onEnd: () => {
          botB?.classList.remove('streaming');
          if (text) history.push({ role: 'user', text: msg }, { role: 'assistant', text });
          closeChat = null;
          send.disabled = false;
          ask.focus();
        },
        onError: (m) => {
          bubble('bot').textContent = `⚠ ${m}`;
          closeChat = null;
          send.disabled = false;
        },
      },
    );

    function onChunk(c: AssistantChunk): void {
      if (c.type === 'text') {
        if (!botB) botB = bubble('bot streaming');
        text += c.text ?? '';
        botB.textContent = text;
        log.scrollTop = log.scrollHeight;
      } else if (c.type === 'tool_use') {
        pending[c.callId || c.name || ''] = toolLine(c.name ?? '');
        botB = null;
      } else if (c.type === 'tool_result') {
        const ln = pending[c.callId || c.name || ''];
        if (ln) {
          ln.className = `pod-tool ${c.isError ? 'fail' : 'ok'}`;
          ln.textContent = t(c.isError ? 'assistant.failed' : 'assistant.done', { name: c.name ?? '' });
        }
      } else if (c.type === 'confirm_request') {
        void mcp.ui
          .confirm({ title: c.name, message: JSON.stringify(c.input, null, 2), danger: true })
          .then((okv) => mcp.assistant.confirm(c.callId ?? '', okv));
      } else if (c.type === 'error') {
        botB?.classList.remove('streaming');
        bubble('bot').textContent = `⚠ ${c.message ?? ''}`;
      }
    }
  }

  ask.addEventListener('input', () => {
    ask.style.height = 'auto';
    ask.style.height = `${Math.min(ask.scrollHeight, 120)}px`;
  });
  ask.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      go();
    }
  });
  ask.focus();
}

function option(value: string, label: string): HTMLOptionElement {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  return o;
}
