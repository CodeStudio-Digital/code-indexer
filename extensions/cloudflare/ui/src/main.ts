/**
 * Boot: build the shell, register every view, restore the persisted
 * navigation stack and mount the router. Status (detect + whoami) warms in
 * the background so the header dot and home cards fill in as data lands.
 */
import { buildShell } from './shell.js';
import { initRouter } from './core/router.js';
import { loadStack } from './core/state.js';
import { fetchAccounts, fetchDetect } from './core/status.js';
import { registerHomeView } from './views/home.js';
import { registerSettingsView } from './views/settings.js';
import { registerRunView } from './views/run.js';
import { registerD1Views } from './views/d1.js';
import { registerKvViews } from './views/kv.js';
import { registerR2Views } from './views/r2.js';
import { registerDnsViews } from './views/dns.js';
import { registerLogsView } from './views/logs.js';
import { registerAssistantView } from './views/assistant.js';
import { registerGenericViews } from './views/generic-domain.js';

async function boot(): Promise<void> {
  const root = document.getElementById('root');
  if (!root) return;

  registerHomeView();
  registerSettingsView();
  registerRunView();
  registerD1Views();
  registerKvViews();
  registerR2Views();
  registerDnsViews();
  registerLogsView();
  registerAssistantView();
  registerGenericViews();

  const restored = await loadStack();
  const shell = buildShell();
  root.appendChild(shell.root);
  initRouter(shell.viewHost, restored);

  void fetchDetect();
  void fetchAccounts();
}

void boot();
