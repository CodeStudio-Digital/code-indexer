// node scripts/release/side-chat-desktop-smoke.mjs dist/codestudio-<version> [--live-chatgpt]
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { _electron as electron, expect } from '@playwright/test';
import { startSideChatProbe } from './side-chat-probe-provider.mjs';

const release = resolve(process.argv[2]);
const live = process.argv.includes('--live-chatgpt');
const providerId = 'openai-chatgpt', model = 'gpt-6.2-sol';
const tag = randomUUID().slice(0, 8).toUpperCase();
const primaryKey = 'LUA' + tag, sideKey = 'MAR' + tag, finalWord = 'CONCLUIDO' + tag;
const rootDir = await realpath(tmpdir());
const root = await mkdtemp(join(rootDir, 'codestudio-side-smoke-'));
const project = join(root, 'project'), profile = join(root, 'profile'), data = join(root, 'data');
const executablePath = join(release, 'win-unpacked', 'CodeStudio.exe');
const ready = { timeout: 90_000 };
const probe = await startSideChatProbe({ live, providerId, model, primaryKey, sideKey, finalWord });
let app;
const report = { provider: providerId, model, transport: live ? 'live ChatGPT through a loopback timing gate' : 'synthetic Responses SSE', passed: false };

async function api(page, path, body, method = body === undefined ? 'GET' : 'POST') {
  return page.evaluate(async ({ path, body, method }) => {
    const response = await fetch('mcp://app/api/' + path, body === undefined ? {} : {
      method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!response.ok) throw Error('HTTP ' + response.status + ' ' + (await response.text()).slice(0, 250));
    return response.json();
  }, { path, body, method });
}
async function stop() {
  if (!app) return;
  const proc = app.process();
  const done = proc.exitCode == null && proc.signalCode == null ? once(proc, 'exit') : Promise.resolve();
  await app.evaluate(({ app }) => app.quit()).catch(() => {}); await done; app = undefined;
}
async function launch() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
    !/^(MCP_|CODER_|CODESTUDIO_|ELECTRON_RUN_AS_NODE$)|(?:_API_KEY|_TOKEN|_SECRET)$/.test(k)));
  Object.assign(env, { MCP_DATA_DIR: data, MCP_INDEX_DB: join(data, 'index.db'), MCP_RUNTIME_COORDINATION_DIR: join(root, 'runtime'),
    MCP_MODEL_CACHE_DIR: join(root, 'models'), MCP_DISABLE_TELEMETRY: '1', CODEX_WEBSOCKET_MODE: '0',
    PROVIDER_REFRESH_INTERVAL_MS: '0', CODESTUDIO_CLOUD_URL: probe.url, CODESTUDIO_PORTAL_URL: probe.url });
  app = await electron.launch({ executablePath, env, cwd: rootDir, timeout: 90_000,
    args: ['--user-data-dir=' + profile, '--disable-gpu', '--disable-background-networking'] });
  const dashboard = () => app.windows().find(w => w.url().includes('/dashboard/index.html'));
  await expect.poll(() => Boolean(dashboard()), ready).toBe(true);
  return dashboard();
}
async function navigate(page, projectId, parent) {
  await page.evaluate(({ projectId, parent }) => {
    localStorage.setItem('mcp-ide:onboarded', 'true'); localStorage.setItem('codestudio:preflight-done', 'true');
    localStorage.setItem('i18n-lang', 'pt-BR'); location.hash = '#/projects/' + projectId + '?session=' + parent;
  }, { projectId, parent });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const row = page.locator('[data-session-id="' + parent + '"]').getByRole('button', { name: 'Principal ' + tag, exact: true });
  await expect(row).toBeVisible(ready);
  await row.click();
  await expect(row).toHaveAttribute('aria-current', 'page');
}
async function mainQueue(page, parent) {
  return page.evaluate(async id => {
    if (!(await indexedDB.databases()).some(db => db.name === 'codestudio-message-queue')) return [];
    return new Promise((resolve, reject) => {
      const opened = indexedDB.open('codestudio-message-queue');
      opened.onerror = () => reject(opened.error);
      opened.onsuccess = () => {
        const db = opened.result;
        const read = db.transaction('sessions', 'readonly').objectStore('sessions').get(id);
        read.onsuccess = () => { db.close(); resolve(read.result ?? []); };
        read.onerror = () => { db.close(); reject(read.error); };
      };
    });
  }, parent);
}
async function parentHashes(bundle) {
  const paths = ['session.json', 'state.json', 'conversation.jsonl'];
  const hashes = {};
  for (const file of paths) hashes[file] = createHash('sha256').update(await readFile(join(bundle,file))).digest('hex');
  return hashes;
}
try {
  await mkdir(project); await writeFile(join(project,'README.md'),'Synthetic side chat isolation project.\n');
  await mkdir(join(profile,'cloud'),{ recursive:true });
  await writeFile(join(profile,'cloud','account.json'),JSON.stringify({ id:'fixture',email:'fixture@example.invalid',emailVerified:true,status:'active' }));
  let page = await launch();
  report.version = await app.evaluate(({ app }) => app.getVersion());
  const { id: projectId } = await api(page,'projects',{name:'Side smoke',root_path:project});
  const present = (await api(page, 'admin/providers')).providers.some(p => p.id === providerId);
  await api(page, present ? 'admin/providers/' + providerId : 'admin/providers',
    { id:providerId,kind:'chatgpt',name:'ChatGPT (Codex)',enabled:true,use_for_coder:true,use_for_agent:true,
      auth_mode:'api_key',api_key:probe.secret,base_url:probe.url+'/codex' }, present ? 'PATCH' : 'POST');
  await api(page,'admin/providers/'+providerId+'/models',{model_id:model,name:model,enabled:true,can_reason:true,
    supported_reasoning_levels:['low','medium','high','max'],default_reasoning_level:'low',context_window:200000,default_max_tokens:4096});
  const { id:parent } = await api(page,'coder/sessions',{project_id:projectId,title:'Principal '+tag,provider:providerId,model,agent:'build',reasoning_effort:'low',max_turns:3,max_auto_continues:0});
  await navigate(page,projectId,parent);
  const primary = page.getByRole('textbox',{name:'Descreva uma tarefa de programação…'}).last();
  await primary.fill('Ensaio sintético. O código do projeto é '+primaryKey+'. Responda literalmente '+finalWord+'. Use apenas texto.');
  await page.getByRole('button',{name:'Enviar',exact:true}).last().click();
  await expect.poll(() => probe.reached.has('main'),ready).toBe(true);
  console.log('Main response streaming.');
  const bundle = join(project,'.mcp-indexer','session',parent);
  const before = await parentHashes(bundle);
  const original = await api(page,'coder/sessions/'+parent+'/collaboration');
  const queue = await mainQueue(page, parent);
  const approvals = page.getByRole('button', {name: /aprova.*pendente|pending approval/i});
  const approvalsBefore = await approvals.count();
  const side = () => page.getByRole('region',{name:'Chat secundário'});
  const chatInput = () => side().getByRole('textbox');
  const current = () => page.locator('[data-session-id="'+parent+'"] [aria-current="page"]');
  const rail = page.getByRole('navigation',{name:'Ferramentas da sessão'}).getByRole('button',{name:'Chat secundário',exact:true});
  await primary.fill('Rascunho anterior ' + tag);
  if (!await side().isVisible()) await rail.click();
  await expect(side()).toBeVisible(ready);
  await expect(primary).toHaveValue('Rascunho anterior ' + tag);
  assert.equal(probe.records.filter(r => ['first','followup','cancel'].includes(r.scenario)).length, 0);
  await rail.click();
  await expect(side()).toHaveCount(0);
  await primary.fill('/side PRIMEIRA_AMOSTRA. Guarde minha palavra lateral '+sideKey+'. Responda somente com o código do projeto que consta no chat principal.');
  await primary.press('Control+Enter');
  const firstAnswer = side().locator('article').first();
  await expect(firstAnswer).toHaveAttribute('data-status', /^(completed|failed|interrupted)$/, ready);
  assert.equal(await firstAnswer.getAttribute('data-status'), 'completed', await firstAnswer.innerText());
  await expect(firstAnswer).toContainText(primaryKey,ready);
  console.log('First side answer received.');
  await primary.fill('Rascunho principal '+tag);
  await chatInput().fill('SEGUNDA_AMOSTRA. Qual palavra lateral pedi para guardar na pergunta anterior? Responda somente a palavra.');
  await side().getByRole('button',{name:'Enviar pergunta'}).click();
  const followup = side().locator('article').nth(1);
  await expect(followup).toHaveAttribute('data-status', /^(completed|failed|interrupted)$/, ready);
  assert.equal(await followup.getAttribute('data-status'), 'completed', await followup.innerText());
  await expect(followup).toContainText(sideKey,ready);
  console.log('Side follow-up received.');
  await chatInput().fill('CANCELAR_AMOSTRA. Escreva uma frase curta sobre o índice.');
  await chatInput().press('Enter');
  await expect.poll(() => probe.reached.has('cancel'),ready).toBe(true);
  await side().getByRole('button',{name:'Cancelar resposta lateral'}).click();
  await expect(side().locator('[data-status="cancelled"]')).toHaveCount(1,ready);
  assert.deepEqual(await parentHashes(bundle),before);
  assert.deepEqual(await mainQueue(page, parent), queue);
  assert.equal(await approvals.count(), approvalsBefore);
  report.parentQueueAndApprovalsUnchanged=true;
  assert.deepEqual((await api(page,'coder/sessions/'+parent+'/collaboration')).messages,original.messages);
  await expect(primary).toHaveValue('Rascunho principal '+tag);
  await expect(current().first()).toBeVisible();
  assert.equal(await readFile(join(project,'README.md'),'utf8'),'Synthetic side chat isolation project.\n');
  assert.deepEqual((await readdir(project)).filter(k=>!k.startsWith('.')),['README.md']);
  assert.equal(probe.records.filter(r=>r.scenario==='main').length,1);
  const mainRequest=probe.records.find(r=>r.scenario==='main');
  const mainId=mainRequest.session;
  assert.ok(mainId, 'The main provider session ID is required');
  const sideRecords=probe.records.filter(r=>['first','followup','cancel'].includes(r.scenario));
  assert.equal(sideRecords.length,3);
  assert.ok(sideRecords.every(r=>r.session && r.session!==mainId && r.toolCount===0 && r.model===model && r.status===200 && r.publicText));
  assert.equal(new Set(sideRecords.map(r=>r.session)).size,1);
  assert.ok(sideRecords.every(r => r.effort === mainRequest.effort), 'The side must inherit the effective main reasoning effort');
  report.effectiveEffort=mainRequest.effort;
  report.parentJournalStateAndMetadataUnchanged=true; report.parentDraftAndSelectionPreserved=true;
  report.publicSideAnswersBeforeParentFinished=2; report.sideCancelledWhileParentActive=true;
  report.separateProviderSessions=true; report.sideToolsOnWire=0;
  console.log('Isolation checks passed, releasing main response.');
  probe.releaseMain();
  await expect.poll(async () => {
    const stored=await api(page,'coder/sessions/'+parent+'?tail=12');
    return (stored.messages??[]).filter(m=>m.role==='assistant').some(m=>JSON.stringify(m.content).includes(finalWord));
  },ready).toBe(true);
  const transcript=await readFile(join(bundle,'conversation.jsonl'),'utf8');
  assert.ok(!transcript.includes(sideKey) && !transcript.includes('SEGUNDA_AMOSTRA') && !transcript.includes('CANCELAR_AMOSTRA'));
  assert.equal(probe.records.filter(r => r.scenario === 'main').length, 1);
  report.parentFinishedOnce=true;
  const turns=(await api(page,'coder/sessions/'+parent+'/side/open',{})).turns;
  report.sideTurns=turns.map(({status,usage,firstTextMs})=>({status,usage,firstTextMs}));
  await stop(); page=await launch(); await navigate(page,projectId,parent);
  if (!await side().isVisible()) await page.getByRole('button',{name:'Chat secundário',exact:true}).first().click();
  await expect(side().locator('[data-status="completed"]')).toHaveCount(2,ready);
  await expect(side().locator('[data-status="cancelled"]')).toHaveCount(1);
  report.survivedAppRestart=true;
  const source = page.locator('[data-side-source]').filter({hasText: primaryKey}).first();
  await source.evaluate((row, key) => {
    const text = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let node = text.nextNode(); node; node = text.nextNode()) {
      const pos = node.textContent.indexOf(key);
      if (pos < 0) continue;
      const range = document.createRange();
      range.setStart(node, pos); range.setEnd(node, pos + key.length);
      document.getSelection().removeAllRanges(); document.getSelection().addRange(range); return;
    }
    throw Error('Public parent text missing from rendered transcript');
  }, primaryKey);
  await page.getByRole('button',{name:'Perguntar sobre este trecho'}).click();
  await expect.poll(async () => (await api(page,'coder/sessions/'+parent+'/side/open',{})).selection?.text,ready).toBe(primaryKey);
  await side().getByRole('button',{name:'Atualizar contexto'}).click();
  await expect.poll(async () => (await api(page,'coder/sessions/'+parent+'/side/open',{})).context.throughSeq,ready).toBeGreaterThan(turns[0].context.throughSeq);
  report.quoteAndExplicitRefresh=true; report.passed=true;
  await writeFile(join(release,live?'side-chat-live-verification.json':'side-chat-verification.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
} catch(error) {
  const dashboard = app?.windows().find(w => w.url().includes('/dashboard/index.html'));
  if (dashboard) console.error('Synthetic desktop:', (await dashboard.locator('body').innerText({ timeout: 5000 }).catch(() => '')).slice(-2200));
  console.error('Probe requests:',JSON.stringify(probe.records.map(({scenario,status,toolCount,publicText})=>({scenario,status,toolCount,publicText}))));
  throw error;
} finally {
  probe.close(); await stop();
  if (await realpath(root)===root && dirname(root)===rootDir) await rm(root,{recursive:true,force:true,maxRetries:12,retryDelay:250});
}
