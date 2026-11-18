import { button, div, el, input, mcp } from '@mcp/plugin-sdk/ui';
import type { FigmaConnectionCommand, FigmaConnectionStatus } from '@mcp/api-bus';

const t = mcp.i18n.translator({
  en: {
    disconnected: 'Figma is disconnected',
    connected: 'Connected as {account}',
    available: '{count} MCP tools available for agents.',
    label: 'Personal access token',
    scope: 'Create a token in Figma → Settings → Security with current_user:read and file_content:read.',
    connect: 'Connect',
    replace: 'Replace token',
    test: 'Test connection',
    disconnect: 'Disconnect',
    working: 'Checking connection…',
    verified: 'Connection verified.',
    usage: 'Paste a Figma file or frame link into a chat to inspect the design or export assets.',
  },
  'pt-BR': {
    disconnected: 'Figma desconectado',
    connected: 'Conta conectada: {account}',
    available: '{count} ferramentas MCP disponíveis para os agentes.',
    label: 'Token de acesso pessoal',
    scope: 'Crie um token em Figma → Configurações → Segurança com current_user:read e file_content:read.',
    connect: 'Conectar',
    replace: 'Trocar token',
    test: 'Testar conexão',
    disconnect: 'Desconectar',
    working: 'Verificando conexão…',
    verified: 'Conexão verificada.',
    usage: 'Cole o link de um arquivo ou frame do Figma no chat para consultar o design ou exportar assets.',
  },
});

const connection = (mcp as typeof mcp & {
  figmaConnection(command: FigmaConnectionCommand): Promise<FigmaConnectionStatus>;
}).figmaConnection;
const root = document.getElementById('root')!;
const status = el('strong');
const detail = el('p', 'figma-help');
const note = el('p', 'figma-help');
note.setAttribute('role', 'status');
const error = el('div', 'figma-error');
error.setAttribute('role', 'alert');

const token = input(undefined, 'password');
token.id = 'figma-token';
token.autocomplete = 'off';
token.spellcheck = false;
token.maxLength = 1024;
token.required = true;
const label = el('label', 'mcp-label', t('label'));
label.htmlFor = token.id;
const form = div('figma-form');
const submit = el('button', 'mcp-btn primary', t('connect'));
submit.type = 'button';
form.append(label, token, el('p', 'figma-help', t('scope')), div('figma-actions', submit));

const test = button(t('test'), 'outline', () => void run({ action: 'test' }));
const disconnect = button(t('disconnect'), 'outline', () => void run({ action: 'disconnect' }));
const replace = button(t('replace'), 'ghost', () => { form.hidden = false; token.focus(); });
const actions = div('figma-actions', test, replace, disconnect);
actions.hidden = true;
form.hidden = true;
root.append(div('figma-state', status, detail), form, actions, note, error);

function show(configuration: FigmaConnectionStatus) {
  status.textContent = configuration.connected
    ? t('connected', { account: configuration.account }) : t('disconnected');
  detail.textContent = configuration.connected ? t('available', { count: configuration.toolCount }) : '';
  form.hidden = configuration.connected;
  actions.hidden = !configuration.connected;
}

async function run(command: FigmaConnectionCommand) {
  for (const control of [token, submit, test, disconnect, replace]) control.disabled = true;
  error.textContent = '';
  note.textContent = t('working');
  try {
    const result = await connection(command);
    show(result);
    note.textContent = command.action === 'test' ? t('verified') : result.connected ? t('usage') : '';
  } catch (reason) {
    error.textContent = reason instanceof Error ? reason.message : String(reason);
    note.textContent = '';
    if (command.action === 'status') form.hidden = false;
  } finally {
    for (const control of [token, submit, test, disconnect, replace]) control.disabled = false;
  }
}

function save() {
  const value = token.value.trim();
  if (!value || submit.disabled) return;
  token.value = '';
  void run({ action: 'connect', token: value });
}
submit.addEventListener('click', save);
token.addEventListener('keydown', event => {
  if (event.key === 'Enter') save();
});
void run({ action: 'status' });
