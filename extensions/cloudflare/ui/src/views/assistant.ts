/**
 * Scoped Cloudflare assistant — chat over `mcp.assistant` (host-run LLM
 * restricted to this plugin's tools). Mutating tool calls arrive as
 * confirm_request chunks and are approved through the host confirm dialog.
 * Chat-specific classes (cf-msg/cf-bubble/…) live in panel.template.html.
 */
import { button, clear, div, el, select, textarea } from '../core/dom.js';
import { confirmDanger } from '../core/api.js';
import { registerView } from '../core/router.js';
import { mcp, type AssistantChunk, type ModelOption } from '../core/mcp.js';
import { t } from '../core/i18n.js';

export function registerAssistantView(): void {
  registerView({
    id: 'assistant',
    label: () => t('assistant.title'),
    render(host) {
      const modelSel = select([{ value: '', label: t('assistant.loadingModels') }]);
      const log = div('cf-chat-log mcp-scroll mcp-grow');
      log.appendChild(div('mcp-empty', el('div', null, t('assistant.empty'))));
      const ask = textarea(t('assistant.placeholder'));
      ask.rows = 1;
      ask.classList.add('cf-chat-ask');
      const send = button(t('assistant.send'), 'primary sm', go);
      const inputRow = div('mcp-hstack', ask, send);

      host.append(
        el('p', 'mcp-card-sub', t('assistant.sub')),
        div('mcp-toolbar', modelSel),
        log,
        inputRow,
      );

      let closeChat: (() => void) | null = null;
      let started = false;
      let toolStrip: HTMLElement | null = null;
      const history: Array<{ role: string; text: string }> = [];

      void mcp.assistant.listModels().then((models: ModelOption[]) => {
        clear(modelSel);
        if (!models.length) {
          modelSel.appendChild(new Option(t('assistant.noModels'), ''));
          return;
        }
        for (const m of models) {
          const o = new Option(m.label + (m.isDefault ? ' *' : ''), `${m.providerId}|${m.modelId}`);
          o.selected = !!m.isDefault;
          modelSel.appendChild(o);
        }
      });

      const ensureStarted = () => {
        if (!started) {
          clear(log);
          started = true;
        }
      };
      const bubble = (cls: string, text?: string) => {
        ensureStarted();
        toolStrip = null;
        const wrap = div(`cf-msg ${cls}`);
        const b = div('cf-bubble', text ?? '');
        wrap.appendChild(b);
        log.appendChild(wrap);
        log.scrollTop = log.scrollHeight;
        return b;
      };
      const toolLine = (name: string) => {
        ensureStarted();
        if (!toolStrip) {
          toolStrip = div('cf-tools');
          log.appendChild(toolStrip);
        }
        const line = div('cf-tool-line', el('span', 'mcp-spinner'), el('span', null, t('assistant.running', { name })));
        toolStrip.appendChild(line);
        log.scrollTop = log.scrollHeight;
        return line;
      };

      function go(): void {
        const msg = ask.value.trim();
        if (!msg || closeChat) return;
        ask.value = '';
        ask.style.height = 'auto';
        bubble('user', msg);
        const [providerId, modelId] = (modelSel.value || '').split('|');
        let text = '';
        let botEl: HTMLElement | null = null;
        const pendingTools: Record<string, HTMLElement> = {};
        send.disabled = true;

        closeChat = mcp.assistant.chat(
          msg,
          { providerId: providerId || undefined, modelId: modelId || undefined, history: history.slice() },
          {
            onData(c: AssistantChunk) {
              if (c.type === 'text' && c.text) {
                if (!botEl) botEl = bubble('bot');
                text += c.text;
                botEl.textContent = text;
                log.scrollTop = log.scrollHeight;
              } else if (c.type === 'tool_use' && c.name) {
                pendingTools[c.callId || c.name] = toolLine(c.name);
                botEl = null;
              } else if (c.type === 'tool_result' && c.name) {
                const line = pendingTools[c.callId || c.name];
                if (line) {
                  line.className = `cf-tool-line ${c.isError ? 'err' : 'ok'}`;
                  line.replaceChildren(
                    el('span', `mcp-dot ${c.isError ? 'err' : 'ok'}`),
                    el('span', null, c.isError ? t('assistant.toolFailed', { name: c.name }) : c.name),
                  );
                }
              } else if (c.type === 'confirm_request' && c.callId) {
                void confirmDanger(c.name ?? t('assistant.confirmTitle'), JSON.stringify(c.input ?? {}, null, 2))
                  .then((ok) => mcp.assistant.confirm(c.callId as string, ok));
              } else if (c.type === 'error' && c.message) {
                bubble('bot err', `⚠ ${c.message}`);
              }
            },
            onEnd() {
              if (text) history.push({ role: 'user', text: msg }, { role: 'assistant', text });
              closeChat = null;
              send.disabled = false;
              ask.focus();
            },
            onError(m: string) {
              bubble('bot err', `⚠ ${m}`);
              closeChat = null;
              send.disabled = false;
            },
          },
        );
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

      return () => {
        if (closeChat) closeChat();
      };
    },
  });
}
